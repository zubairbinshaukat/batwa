// End-to-end tests for the relay, run against a real `wrangler dev --local`.

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startWorker, stopWorker, newSpaceId, newToken, sha256Hex,
  makeSubscription, decryptPush, deliveries,
} from "./helpers.mjs";

const PORT = 8787;
let worker;
let base;

before(async () => {
  worker = await startWorker(PORT);
  base = worker.base;
}, { timeout: 180_000 });

after(() => stopWorker(worker?.child));

const url = (id, suffix = "") => `${base}/v1/space/${id}${suffix}`;
const auth = (token, extra) => ({ "X-Space-Token": token, "Content-Type": "application/json", ...extra });

async function createSpace(blob = "cipher-0") {
  const id = newSpaceId();
  const token = newToken();
  const res = await fetch(url(id), {
    method: "PUT",
    headers: auth(token, { "If-Match": '"0"' }),
    body: JSON.stringify({ version: 0, blob }),
  });
  assert.equal(res.status, 201);
  return { id, token, body: await res.json() };
}

describe("space lifecycle", () => {
  test("first PUT creates, GET reads it back, no-store everywhere", async () => {
    const { id, token, body } = await createSpace("cipher-one");
    assert.equal(body.version, 1);

    const res = await fetch(url(id), { headers: auth(token) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("etag"), '"1"');
    const got = await res.json();
    assert.equal(got.version, 1);
    assert.equal(got.blob, "cipher-one");
    assert.ok(got.updatedAt);
  });

  test("a space id that is not 22 chars of base64url is rejected", async () => {
    const res = await fetch(`${base}/v1/space/short`, { headers: auth("t") });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "bad-space-id");
  });

  test("the wrong token is 401 on read and on write", async () => {
    const { id } = await createSpace();
    const read = await fetch(url(id), { headers: auth(newToken()) });
    assert.equal(read.status, 401);

    const write = await fetch(url(id), {
      method: "PUT",
      headers: auth(newToken(), { "If-Match": '"1"' }),
      body: JSON.stringify({ version: 1, blob: "nope" }),
    });
    assert.equal(write.status, 401);

    const none = await fetch(url(id), { method: "GET" });
    assert.equal(none.status, 401);
  });

  test("an unknown space is 404", async () => {
    const res = await fetch(url(newSpaceId()), { headers: auth(newToken()) });
    assert.equal(res.status, 404);
  });
});

describe("versioning", () => {
  test("a stale If-Match is 412 and hands back the current version and blob", async () => {
    const { id, token } = await createSpace("v1-blob");
    const ok = await fetch(url(id), {
      method: "PUT",
      headers: auth(token, { "If-Match": '"1"' }),
      body: JSON.stringify({ version: 1, blob: "v2-blob" }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).version, 2);

    const stale = await fetch(url(id), {
      method: "PUT",
      headers: auth(token, { "If-Match": '"1"' }),
      body: JSON.stringify({ version: 1, blob: "loser" }),
    });
    assert.equal(stale.status, 412);
    const body = await stale.json();
    assert.equal(body.version, 2);
    assert.equal(body.blob, "v2-blob");

    const after = await (await fetch(url(id), { headers: auth(token) })).json();
    assert.equal(after.blob, "v2-blob", "the losing write must not have landed");
  });

  test("HEAD gives the version, and If-None-Match gives 304", async () => {
    const { id, token } = await createSpace("head-blob");

    const head = await fetch(url(id), { method: "HEAD", headers: auth(token) });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("etag"), '"1"');
    assert.equal(head.headers.get("x-version"), "1");

    const fresh = await fetch(url(id), { headers: auth(token, { "If-None-Match": '"1"' }) });
    assert.equal(fresh.status, 304);

    const changed = await fetch(url(id), { headers: auth(token, { "If-None-Match": '"0"' }) });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).blob, "head-blob");
  });

  test("a blob over 1 MiB is 413", async () => {
    const id = newSpaceId();
    const token = newToken();
    const res = await fetch(url(id), {
      method: "PUT",
      headers: auth(token, { "If-Match": '"0"' }),
      body: JSON.stringify({ version: 0, blob: "x".repeat(1024 * 1024 + 1) }),
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error, "too-large");
  });
});

describe("push", () => {
  test("subscribe, notify, and the payload decrypts with the subscription keys", async () => {
    const { id, token } = await createSpace();
    const box = "inbox" + Math.random().toString(36).slice(2, 10);
    const sub = await makeSubscription(base, box);

    const put = await fetch(url(id, "/sub/device-a"), {
      method: "PUT",
      headers: auth(token),
      body: JSON.stringify({ memberId: "m-a", subscription: sub.json }),
    });
    assert.equal(put.status, 200);

    const notify = await fetch(url(id, "/notify"), {
      method: "POST",
      headers: auth(token, { "X-Space-Id": id }),
      body: JSON.stringify({ payload: "b64-ciphertext-from-the-phone", exceptDeviceId: "device-b" }),
    });
    assert.equal(notify.status, 200);
    assert.deepEqual(await notify.json(), { sent: 1, gone: 0, goneDevices: [] });

    const got = await deliveries(base, box);
    assert.equal(got.length, 1);
    assert.equal(got[0].encoding, "aes128gcm");
    assert.match(got[0].auth, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);

    const plain = await decryptPush(got[0].body, sub);
    assert.deepEqual(JSON.parse(plain), { s: id, p: "b64-ciphertext-from-the-phone" });
  });

  test("exceptDeviceId skips the sender's own device", async () => {
    const { id, token } = await createSpace();
    const box = "self" + Math.random().toString(36).slice(2, 10);
    const sub = await makeSubscription(base, box);
    await fetch(url(id, "/sub/mine"), {
      method: "PUT", headers: auth(token),
      body: JSON.stringify({ memberId: "m", subscription: sub.json }),
    });
    const res = await fetch(url(id, "/notify"), {
      method: "POST", headers: auth(token, { "X-Space-Id": id }),
      body: JSON.stringify({ payload: "p", exceptDeviceId: "mine" }),
    });
    assert.deepEqual(await res.json(), { sent: 0, gone: 0, goneDevices: [] });
    assert.equal((await deliveries(base, box)).length, 0);
  });

  test("404 and 410 from the push service prune the subscription", async () => {
    const { id, token } = await createSpace();
    const dead = await makeSubscription(base, "gone" + Math.random().toString(36).slice(2, 8));
    const missing = await makeSubscription(base, "missing" + Math.random().toString(36).slice(2, 8));
    const live = await makeSubscription(base, "live" + Math.random().toString(36).slice(2, 8));

    for (const [device, s] of [["d-gone", dead], ["d-missing", missing], ["d-live", live]]) {
      await fetch(url(id, "/sub/" + device), {
        method: "PUT", headers: auth(token),
        body: JSON.stringify({ memberId: device, subscription: s.json }),
      });
    }

    const first = await (await fetch(url(id, "/notify"), {
      method: "POST", headers: auth(token, { "X-Space-Id": id }),
      body: JSON.stringify({ payload: "p1" }),
    })).json();
    assert.equal(first.sent, 1);
    assert.equal(first.gone, 2);
    assert.deepEqual(first.goneDevices.sort(), ["d-gone", "d-missing"]);

    const second = await (await fetch(url(id, "/notify"), {
      method: "POST", headers: auth(token, { "X-Space-Id": id }),
      body: JSON.stringify({ payload: "p2" }),
    })).json();
    assert.deepEqual(second, { sent: 1, gone: 0, goneDevices: [] }, "dead subs are gone for good");
  });

  test("DELETE /sub/:deviceId unsubscribes", async () => {
    const { id, token } = await createSpace();
    const box = "unsub" + Math.random().toString(36).slice(2, 10);
    const sub = await makeSubscription(base, box);
    await fetch(url(id, "/sub/d1"), {
      method: "PUT", headers: auth(token),
      body: JSON.stringify({ memberId: "m", subscription: sub.json }),
    });
    const del = await fetch(url(id, "/sub/d1"), { method: "DELETE", headers: auth(token) });
    assert.equal(del.status, 200);
    const res = await (await fetch(url(id, "/notify"), {
      method: "POST", headers: auth(token, { "X-Space-Id": id }),
      body: JSON.stringify({ payload: "p" }),
    })).json();
    assert.equal(res.sent, 0);
  });

  test("a payload over 3 KiB is 413", async () => {
    const { id, token } = await createSpace();
    const res = await fetch(url(id, "/notify"), {
      method: "POST", headers: auth(token, { "X-Space-Id": id }),
      body: JSON.stringify({ payload: "p".repeat(3 * 1024 + 1) }),
    });
    assert.equal(res.status, 413);
  });
});

describe("token rotation and deletion", () => {
  test("rotate swaps the token so old invites stop working", async () => {
    const { id, token } = await createSpace("rot-blob");
    const newTok = newToken();
    const res = await fetch(url(id, "/rotate"), {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ newTokenHash: await sha256Hex(newTok) }),
    });
    assert.equal(res.status, 200);

    const old = await fetch(url(id), { headers: auth(token) });
    assert.equal(old.status, 401);

    const fresh = await fetch(url(id), { headers: auth(newTok) });
    assert.equal(fresh.status, 200);
    assert.equal((await fresh.json()).blob, "rot-blob", "data survives a rotate");
  });

  test("DELETE wipes the blob and the subscriptions", async () => {
    const { id, token } = await createSpace("doomed");
    const box = "wipe" + Math.random().toString(36).slice(2, 10);
    const sub = await makeSubscription(base, box);
    await fetch(url(id, "/sub/d1"), {
      method: "PUT", headers: auth(token),
      body: JSON.stringify({ memberId: "m", subscription: sub.json }),
    });

    const del = await fetch(url(id), { method: "DELETE", headers: auth(token) });
    assert.equal(del.status, 200);

    const gone = await fetch(url(id), { headers: auth(token) });
    assert.equal(gone.status, 404);

    // The id is free again, and the old token no longer owns it.
    const recreate = await fetch(url(id), {
      method: "PUT", headers: auth(newToken(), { "If-Match": '"0"' }),
      body: JSON.stringify({ version: 0, blob: "new life" }),
    });
    assert.equal(recreate.status, 201);
    assert.equal((await recreate.json()).version, 1, "versions restart after a wipe");
  });
});

describe("rate limits", () => {
  test("a space is cut off after 60 writes in a minute", async () => {
    const { id, token } = await createSpace();
    let limited = 0;
    for (let i = 0; i < 62; i++) {
      const res = await fetch(url(id), {
        method: "PUT", headers: auth(token, { "If-Match": "*" }),
        body: JSON.stringify({ blob: "b" + i }),
      });
      if (res.status === 429) {
        limited++;
        assert.equal(res.headers.get("retry-after"), "60");
      }
      await res.arrayBuffer();
    }
    assert.ok(limited >= 2, `expected the tail to be rate limited, got ${limited}`);
  });
});

describe("CORS", () => {
  test("the app origin is allowed and anything else is refused", async () => {
    const { id, token } = await createSpace();
    const good = await fetch(url(id), { headers: auth(token, { Origin: "http://127.0.0.1:5173" }) });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");

    const bad = await fetch(url(id), { headers: auth(token, { Origin: "https://evil.example" }) });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get("access-control-allow-origin"), null);

    const preflight = await fetch(url(id), {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173", "Access-Control-Request-Method": "PUT" },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers"), /X-Space-Token/);
  });
});
