// One Durable Object for the whole relay: how many times Batwa was installed.
//
//   c:android | c:ios | c:other   whole numbers, nothing else about anyone
//   n:<nonce>                     ms timestamp, deleted after 7 days
//
// A phone sends `{ p, n }` once, the first time Batwa runs as an installed
// app: the platform word and a random one-time nonce. The nonce exists only
// so a retry after a lost response is not counted twice; it is random, tied
// to nothing, and gone within a week. No IP, no user agent, no id is stored.
//
// A Durable Object handles one request at a time, so read-increment-write is
// atomic without a transaction.

const PLATFORMS = ["android", "ios", "other"];
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_BODY = 256;
const NONCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function json(body, status = 200, extra) {
  const h = new Headers(extra);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export class Stats {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/install" && request.method === "POST") return this.install(request);
    if (path === "/stats" && request.method === "GET") return json(await this.counts());
    if (path === "/purge" && request.method === "POST" && String(this.env.TEST_MODE || "") === "1") {
      const { now } = await request.json();
      return json({ purged: await this.purge(Number(now) || Date.now()) });
    }
    return json({ error: "not-found" }, 404);
  }

  async install(request) {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: "too-large" }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "bad-body" }, 400); }
    const p = body && body.p;
    const n = body && body.n;
    if (!PLATFORMS.includes(p) || typeof n !== "string" || !NONCE_RE.test(n)) {
      return json({ error: "bad-body" }, 400);
    }

    const nonceKey = "n:" + n;
    if (await this.storage.get(nonceKey)) return json({ ok: true, dup: true });

    const countKey = "c:" + p;
    const count = (Number(await this.storage.get(countKey)) || 0) + 1;
    await this.storage.put({ [countKey]: count, [nonceKey]: Date.now() });
    if ((await this.storage.getAlarm()) == null) {
      await this.storage.setAlarm(Date.now() + DAY_MS);
    }
    return json({ ok: true });
  }

  async counts() {
    const got = await this.storage.get(PLATFORMS.map((p) => "c:" + p));
    const out = {};
    for (const p of PLATFORMS) out[p] = Number(got.get("c:" + p)) || 0;
    return { total: out.android + out.ios + out.other, ...out };
  }

  /** Drop every nonce older than a week. Returns how many went. */
  async purge(now) {
    const old = [];
    for (const [key, at] of await this.storage.list({ prefix: "n:" })) {
      if (now - (Number(at) || 0) >= NONCE_TTL_MS) old.push(key);
    }
    // storage.delete takes at most 128 keys per call.
    for (let i = 0; i < old.length; i += 128) await this.storage.delete(old.slice(i, i + 128));
    return old.length;
  }

  async alarm() {
    await this.purge(Date.now());
    const left = await this.storage.list({ prefix: "n:", limit: 1 });
    if (left.size) await this.storage.setAlarm(Date.now() + DAY_MS);
  }
}
