// One Durable Object per space. Holds:
//   meta   { tokenHash, version, updatedAt }
//   blob   the opaque ciphertext string the app PUT
//   sub:<deviceId>  { memberId, subscription, at }
//
// Nothing here is ever inspected. `blob` and push payloads are opaque.

import { sendPush } from "./push.js";

const MAX_BLOB = 1024 * 1024;      // 1 MiB
const MAX_PAYLOAD = 3 * 1024;      // 3 KiB of base64
const WRITE_LIMIT = 60;            // per space, per minute
const NOTIFY_LIMIT = 30;           // per space, per minute
const WINDOW_MS = 60_000;

const enc = new TextEncoder();

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200, extra) {
  const h = new Headers(extra);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

/** `"3"`, `W/"3"` and `3` all mean version 3. `*` means "any". */
function parseTag(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (s === "*") return "*";
  s = s.replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!/^\d+$/.test(s)) return NaN;
  return Number(s);
}

export class Space {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.windows = new Map(); // in-memory, per-object rate windows
  }

  hit(kind, limit) {
    const now = Date.now();
    let rec = this.windows.get(kind);
    if (!rec || now - rec.start >= WINDOW_MS) {
      rec = { start: now, n: 0 };
      this.windows.set(kind, rec);
    }
    rec.n++;
    return rec.n <= limit;
  }

  async meta() {
    return (await this.storage.get("meta")) || null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Test-only inbox for the fake push service (see src/index.js).
    if (path.startsWith("/__inbox/")) return this.inbox(request, path.slice(9));

    const token = request.headers.get("X-Space-Token") || "";
    if (!token || token.length > 512) return json({ error: "unauthorised" }, 401);
    const tokenHash = await sha256Hex(token);

    const meta = await this.meta();

    if (path === "/" && request.method === "PUT") return this.put(request, meta, tokenHash);

    if (!meta) return json({ error: "not-found" }, 404);
    if (!sameSecret(meta.tokenHash, tokenHash)) return json({ error: "unauthorised" }, 401);

    if (path === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return this.get(request, meta);
    }
    if (path === "/" && request.method === "DELETE") return this.wipe();
    if (path === "/rotate" && request.method === "POST") return this.rotate(request, meta);
    if (path === "/notify" && request.method === "POST") return this.notify(request);

    const sub = path.match(/^\/sub\/([A-Za-z0-9_.-]{1,64})$/);
    if (sub && request.method === "PUT") return this.subscribe(request, sub[1]);
    if (sub && request.method === "DELETE") return this.unsubscribe(sub[1]);

    return json({ error: "not-found" }, 404);
  }

  async put(request, meta, tokenHash) {
    if (!this.hit("write", WRITE_LIMIT)) {
      return json({ error: "rate-limit" }, 429, { "Retry-After": "60" });
    }
    if (meta && !sameSecret(meta.tokenHash, tokenHash)) return json({ error: "unauthorised" }, 401);

    const raw = await request.text();
    if (raw.length > MAX_BLOB + 4096) return json({ error: "too-large" }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "bad-body" }, 400); }
    if (!body || typeof body.blob !== "string") return json({ error: "bad-body" }, 400);
    if (enc.encode(body.blob).length > MAX_BLOB) return json({ error: "too-large" }, 413);

    const current = meta ? meta.version : 0;
    let expect = parseTag(request.headers.get("If-Match"));
    if (expect === null) expect = typeof body.version === "number" ? body.version : null;
    if (Number.isNaN(expect)) return json({ error: "bad-if-match" }, 400);

    const conflict = async () =>
      json(
        { error: "conflict", version: current, blob: (await this.storage.get("blob")) ?? null },
        412,
        { ETag: `"${current}"` }
      );

    if (expect !== "*" && expect !== null && expect !== current) return conflict();
    if (expect === null && meta) return conflict();

    const version = current + 1;
    const updatedAt = new Date().toISOString();
    await this.storage.put({
      meta: { tokenHash: meta ? meta.tokenHash : tokenHash, version, updatedAt },
      blob: body.blob,
    });
    return json({ version, updatedAt }, meta ? 200 : 201, { ETag: `"${version}"` });
  }

  async get(request, meta) {
    const inm = parseTag(request.headers.get("If-None-Match"));
    const headers = { ETag: `"${meta.version}"`, "X-Version": String(meta.version) };
    if (inm === "*" || inm === meta.version) {
      return new Response(null, { status: 304, headers: { ...headers, "Cache-Control": "no-store" } });
    }
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          ...headers,
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }
    const blob = (await this.storage.get("blob")) ?? null;
    return json({ version: meta.version, blob, updatedAt: meta.updatedAt }, 200, headers);
  }

  async wipe() {
    await this.storage.deleteAll();
    this.windows.clear();
    return json({ deleted: true });
  }

  async rotate(request, meta) {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad-body" }, 400); }
    const h = body && body.newTokenHash;
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return json({ error: "bad-body" }, 400);
    await this.storage.put("meta", { ...meta, tokenHash: h });
    return json({ rotated: true, version: meta.version });
  }

  async subscribe(request, deviceId) {
    if (!this.hit("write", WRITE_LIMIT)) {
      return json({ error: "rate-limit" }, 429, { "Retry-After": "60" });
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad-body" }, 400); }
    const s = body && body.subscription;
    if (!s || typeof s.endpoint !== "string" || !s.keys || !s.keys.p256dh || !s.keys.auth) {
      return json({ error: "bad-body" }, 400);
    }
    await this.storage.put("sub:" + deviceId, {
      memberId: typeof body.memberId === "string" ? body.memberId : null,
      subscription: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
      at: Date.now(),
    });
    return json({ subscribed: true });
  }

  async unsubscribe(deviceId) {
    await this.storage.delete("sub:" + deviceId);
    return json({ unsubscribed: true });
  }

  async notify(request) {
    if (!this.hit("notify", NOTIFY_LIMIT)) {
      return json({ error: "rate-limit" }, 429, { "Retry-After": "60" });
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad-body" }, 400); }
    const payload = body && body.payload;
    if (typeof payload !== "string" || !payload) return json({ error: "bad-body" }, 400);
    if (payload.length > MAX_PAYLOAD) return json({ error: "too-large" }, 413);
    const except = typeof body.exceptDeviceId === "string" ? body.exceptDeviceId : null;

    const subs = await this.storage.list({ prefix: "sub:" });
    const priv = this.env.VAPID_PRIVATE_KEY;
    const pub = this.env.VAPID_PUBLIC_KEY;
    const subject = this.env.VAPID_SUBJECT || "mailto:relay@invalid";
    if (!priv || !pub) return json({ error: "push-not-configured" }, 503);

    // The space id is not a secret to the relay, so it travels with the
    // ciphertext to let the service worker pick the right notification key.
    const spaceId = request.headers.get("X-Space-Id") || null;
    const text = JSON.stringify({ s: spaceId, p: payload });

    let sent = 0;
    const gone = [];
    for (const [key, rec] of subs) {
      const deviceId = key.slice(4);
      if (except && deviceId === except) continue;
      let status = 0;
      try {
        status = await sendPush(rec.subscription, text, {
          publicKey: pub,
          privateKey: priv,
          subject,
        });
      } catch {
        status = 0;
      }
      if (status === 404 || status === 410) {
        gone.push(deviceId);
        await this.storage.delete(key);
      } else if (status >= 200 && status < 300) {
        sent++;
      }
    }
    return json({ sent, gone: gone.length, goneDevices: gone });
  }

  /** TEST_MODE only: records what the fake push service received. */
  async inbox(request, box) {
    if (String(this.env.TEST_MODE || "") !== "1") return json({ error: "not-found" }, 404);
    const key = "inbox:" + box;
    if (request.method === "POST") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const list = (await this.storage.get(key)) || [];
      list.push({
        body: [...bytes],
        auth: request.headers.get("X-Rec-Auth") || "",
        encoding: request.headers.get("X-Rec-Encoding") || "",
        ttl: request.headers.get("X-Rec-Ttl") || "",
      });
      await this.storage.put(key, list);
      return new Response(null, { status: 201 });
    }
    return json({ deliveries: (await this.storage.get(key)) || [] });
  }
}
