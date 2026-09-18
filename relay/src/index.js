// Batwa relay — router, CORS, per-IP rate limiting.
//
// Privacy rules enforced here:
//   * no request or response body is ever logged;
//   * every response is Cache-Control: no-store;
//   * CORS is locked to ALLOWED_ORIGIN (plus the literal `null` origin that
//     installed PWAs send) so a random page cannot use a leaked token silently.

import { Space } from "./space.js";

export { Space };

/** 128 bits of randomness, base64url, no padding. */
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Per-IP budget. Best effort: it is per isolate, not global. */
const IP_LIMIT = 600;
const IP_WINDOW_MS = 60_000;
const ipHits = new Map();

function rateLimitIp(ip, limit) {
  const now = Date.now();
  let rec = ipHits.get(ip);
  if (!rec || now - rec.start >= IP_WINDOW_MS) {
    rec = { start: now, n: 0 };
    ipHits.set(ip, rec);
  }
  rec.n++;
  if (ipHits.size > 10000) {
    for (const [k, v] of ipHits) if (now - v.start >= IP_WINDOW_MS) ipHits.delete(k);
  }
  return rec.n <= limit;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const h = new Headers();
  if (!origin) return h; // same-origin / non-browser caller: nothing to say
  const allowed =
    origin === env.ALLOWED_ORIGIN ||
    (origin === "null" && String(env.ALLOW_NULL_ORIGIN ?? "1") === "1");
  if (!allowed) return h;
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, If-Match, If-None-Match, X-Space-Token, X-Space-Id");
  h.set("Access-Control-Expose-Headers", "ETag, X-Version, Retry-After");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return (
    origin === env.ALLOWED_ORIGIN ||
    (origin === "null" && String(env.ALLOW_NULL_ORIGIN ?? "1") === "1")
  );
}

function json(body, status, extra) {
  const h = new Headers(extra);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: h });
}

function finish(res, request, env) {
  const h = new Headers(res.headers);
  h.set("Cache-Control", "no-store");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
  for (const [k, v] of corsHeaders(request, env)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return finish(new Response(null, { status: 204 }), request, env);
    }

    if (!originAllowed(request, env)) {
      return finish(json({ error: "origin-not-allowed" }, 403), request, env);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "local";
    if (!rateLimitIp(ip, IP_LIMIT)) {
      return finish(json({ error: "rate-limit" }, 429, { "Retry-After": "60" }), request, env);
    }

    // Test-only fake push endpoint, wired in the same worker so the suite can
    // assert what the relay actually sent. Never present in production.
    if (String(env.TEST_MODE || "") === "1" && url.pathname.startsWith("/__test/")) {
      return finish(await testRoute(request, env, url), request, env);
    }

    const m = url.pathname.match(/^\/v1\/space\/([^/]+)(\/.*)?$/);
    if (!m) return finish(json({ error: "not-found" }, 404), request, env);

    const id = m[1];
    const rest = m[2] || "/";
    if (!ID_RE.test(id)) return finish(json({ error: "bad-space-id" }, 400), request, env);

    // Buffer the body before handing it to the Durable Object: the object does
    // storage work before it reads the body, and a streamed request body does
    // not survive that in workerd.
    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const buf = await request.arrayBuffer();
      if (buf.byteLength) body = buf;
    }

    const stub = env.SPACES.get(env.SPACES.idFromName(id));
    const inner = new URL(request.url);
    inner.pathname = rest;
    const res = await stub.fetch(
      new Request(inner.toString(), { method: request.method, headers: request.headers, body })
    );
    return finish(res, request, env);
  },
};

/** Fake push service used by the test suite (TEST_MODE only). */
async function testRoute(request, env, url) {
  // /__test/push/<box>   POST  — pretend to be a push service
  // /__test/pushed/<box> GET   — read back what arrived
  const push = url.pathname.match(/^\/__test\/push\/([A-Za-z0-9_-]+)$/);
  const read = url.pathname.match(/^\/__test\/pushed\/([A-Za-z0-9_-]+)$/);
  const box = push?.[1] || read?.[1];
  if (!box) return json({ error: "not-found" }, 404);

  // Boxes whose name starts with these words simulate a dead subscription.
  if (push && box.startsWith("gone")) return new Response(null, { status: 410 });
  if (push && box.startsWith("missing")) return new Response(null, { status: 404 });

  const stub = env.SPACES.get(env.SPACES.idFromName("__test_push_inbox"));
  const inner = new URL(request.url);
  inner.pathname = push ? "/__inbox/" + box : "/__inbox/" + box;
  if (push) {
    const body = new Uint8Array(await request.arrayBuffer());
    return stub.fetch(new Request(inner.toString(), {
      method: "POST",
      headers: {
        "X-Rec-Auth": request.headers.get("Authorization") || "",
        "X-Rec-Encoding": request.headers.get("Content-Encoding") || "",
        "X-Rec-Ttl": request.headers.get("TTL") || "",
      },
      body,
    }));
  }
  return stub.fetch(new Request(inner.toString(), { method: "GET" }));
}
