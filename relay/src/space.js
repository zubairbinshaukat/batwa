// One Durable Object per space. Holds:
//   meta   { tokenHash, version, updatedAt }
//   blob   the opaque ciphertext string the app PUT
//   sub:<deviceId>  { memberId, subscription, at }
//
// Nothing here is ever inspected. `blob` and push payloads are opaque.

import { sendPush } from "./push.js";

const MAX_BLOB = 1024 * 1024;      // 1 MiB
const MAX_PAYLOAD = 3 * 1024;      // 3 KiB of base64
const ID_FIELD = /^[A-Za-z0-9_.-]{1,64}$/;
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

/** The host of a push endpoint, for logs that say nothing else. */
function hostOf(endpoint) {
  try { return new URL(endpoint).host; } catch { return "?"; }
}

/**
 * The VAPID pair and subject, or the reason there is none. A subject that is
 * not a real `mailto:` or `https:` URL is refused here rather than by Apple,
 * whose push service rejects it with a 403 that nobody would ever see.
 */
function vapidOf(env) {
  const missing = [];
  if (!env.VAPID_PRIVATE_KEY) missing.push("VAPID_PRIVATE_KEY");
  if (!env.VAPID_PUBLIC_KEY) missing.push("VAPID_PUBLIC_KEY");
  const subject = String(env.VAPID_SUBJECT || "");
  if (!/^(mailto:[^@\s]+@[^@\s]+\.[^@\s]+|https:\/\/\S+)$/.test(subject)) missing.push("VAPID_SUBJECT");
  if (missing.length) return { error: "push-not-configured", missing };
  return {
    vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject },
  };
}

/**
 * Validate the `{ payload, exceptDeviceId, onlyDeviceId, onlyMemberId, urgent }`
 * a notify (or a PUT's `notify` field) carries. The payload stays opaque.
 */
function readNotify(body) {
  const b = body && typeof body === "object" ? body : {};
  const payload = b.payload;
  if (typeof payload !== "string" || !payload) return { error: "bad-body", status: 400 };
  if (payload.length > MAX_PAYLOAD) return { error: "too-large", status: 413 };
  const id = (v) => (typeof v === "string" && ID_FIELD.test(v) ? v : null);
  // A target that is present but malformed must fail closed: quietly dropping
  // it would turn a push meant for one phone into a push to the whole space.
  for (const k of ["onlyDeviceId", "onlyMemberId"]) {
    if (b[k] != null && !id(b[k])) return { error: "bad-target", status: 400 };
  }
  return {
    payload,
    exceptDeviceId: id(b.exceptDeviceId),
    onlyDeviceId: id(b.onlyDeviceId),
    onlyMemberId: id(b.onlyMemberId),
    urgent: b.urgent === true,
  };
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

    // A write may carry the notification that describes it (plan 7.2): one
    // request, so the push can never outrun the data it announces, and it
    // still goes out when the sender's app is closed a second after saving.
    let notify = null;
    if (body.notify != null) {
      notify = readNotify(body.notify);
      if (notify.error) return json({ error: notify.error }, notify.status);
    }

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

    // Only after the store succeeded — a 409/412 above never notifies. The
    // fan-out is not awaited, so the writer gets its version back at once.
    let notified = false;
    let notifyError = null;
    if (notify) notifyError = vapidOf(this.env).error || null;
    if (notify && !notifyError && this.hit("notify", NOTIFY_LIMIT)) {
      const spaceId = request.headers.get("X-Space-Id") || null;
      const job = this.fanOut(spaceId, notify).catch(() => {});
      if (this.ctx && typeof this.ctx.waitUntil === "function") this.ctx.waitUntil(job);
      notified = true;
    }
    const extra = notifyError ? { notifyError } : {};
    return json({ version, updatedAt, notified, ...extra }, meta ? 200 : 201, { ETag: `"${version}"` });
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
    const notify = readNotify(body);
    if (notify.error) return json({ error: notify.error }, notify.status);
    const config = vapidOf(this.env);
    if (config.error) return json({ error: config.error, missing: config.missing }, 503);
    const spaceId = request.headers.get("X-Space-Id") || null;
    return json(await this.fanOut(spaceId, notify));
  }

  /**
   * Send one opaque payload to every subscribed device of this space, or to
   * the one device / one member it is aimed at. Returns what happened, in the
   * buckets the app shows in Settings:
   *   sent        accepted by the push service
   *   gone        404/410 — the subscription is dead and has been removed
   *   rejected    400/401/403/413 — the push service refused us (bad VAPID)
   *   retryLater  429, 5xx or no answer — the service may take it next time
   */
  async fanOut(spaceId, { payload, exceptDeviceId, onlyDeviceId, onlyMemberId, urgent }) {
    const out = { sent: 0, gone: 0, goneDevices: [], rejected: 0, retryLater: 0 };
    const config = vapidOf(this.env);
    if (config.error) return { ...out, error: config.error };

    // The space id is not a secret to the relay, so it travels with the
    // ciphertext to let the service worker pick the right notification key.
    const text = JSON.stringify({ s: spaceId, p: payload });
    const subs = await this.storage.list({ prefix: "sub:" });
    for (const [key, rec] of subs) {
      const deviceId = key.slice(4);
      if (exceptDeviceId && deviceId === exceptDeviceId) continue;
      if (onlyDeviceId && deviceId !== onlyDeviceId) continue;
      if (onlyMemberId && rec.memberId !== onlyMemberId) continue;
      let status = 0;
      try {
        status = await sendPush(rec.subscription, text, config.vapid, {
          urgency: urgent ? "high" : "normal",
          // One topic per space: an undelivered older banner for the same
          // space is replaced, not queued behind the new one.
          topic: spaceId && /^[A-Za-z0-9_-]{1,32}$/.test(spaceId) ? spaceId : null,
        });
      } catch {
        status = 0;
      }
      // Status codes and the push service's host only — never an endpoint,
      // a device id, a space id or a body. Enough to read `wrangler tail` by.
      console.log(`push ${hostOf(rec.subscription.endpoint)} ${status}`);
      if (status === 404 || status === 410) {
        out.gone++;
        out.goneDevices.push(deviceId);
        await this.storage.delete(key);
      } else if (status >= 200 && status < 300) {
        out.sent++;
      } else if (status === 429 || status >= 500 || status === 0) {
        out.retryLater++;
      } else {
        out.rejected++;
      }
    }
    return out;
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
        urgency: request.headers.get("X-Rec-Urgency") || "",
        topic: request.headers.get("X-Rec-Topic") || "",
      });
      await this.storage.put(key, list);
      return new Response(null, { status: 201 });
    }
    return json({ deliveries: (await this.storage.get(key)) || [] });
  }
}
