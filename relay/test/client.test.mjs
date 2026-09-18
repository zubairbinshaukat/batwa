// Runs the real browser client (js/relay.js) against `wrangler dev`.
//
// js/relay.js imports `relayUrl` from js/config.js, which is a browser module
// owned by the app. The fixture copies relay.js next to a tiny stub config.js
// in a temp dir so the base URL can point at the dev worker; nothing else about
// the module is changed.

import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  startWorker, stopWorker, newSpaceId, newToken, sha256Hex,
  makeSubscription, decryptPush, deliveries, RELAY_DIR,
} from "./helpers.mjs";

const PORT = 8788;
let worker;
let base;
let relay;
let dir;

before(async () => {
  worker = await startWorker(PORT, { persistSuffix: "-client" });
  base = worker.base;

  dir = mkdtempSync(join(tmpdir(), "batwa-relay-client-"));
  copyFileSync(join(RELAY_DIR, "..", "js", "relay.js"), join(dir, "relay.js"));
  writeFileSync(join(dir, "config.js"), `export const relayUrl = () => ${JSON.stringify(base)};\n`);
  relay = await import(pathToFileURL(join(dir, "relay.js")).href);
}, { timeout: 180_000 });

after(() => {
  stopWorker(worker?.child);
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

const space = () => ({ id: newSpaceId(), token: newToken() });

describe("js/relay.js happy path", () => {
  test("put, get, head, poll, subscribe, notify, rotate, delete", async () => {
    const s = space();

    const created = await relay.relayPut(s, 0, "cipher-1");
    assert.equal(created.version, 1);

    const got = await relay.relayGet(s);
    assert.equal(got.notModified, false);
    assert.equal(got.version, 1);
    assert.equal(got.blob, "cipher-1");

    const head = await relay.relayHead(s);
    assert.equal(head.version, 1);

    const poll = await relay.relayGet(s, { knownVersion: 1 });
    assert.deepEqual(poll, { notModified: true, version: 1 });

    const bumped = await relay.relayPut(s, 1, "cipher-2");
    assert.equal(bumped.version, 2);
    assert.equal((await relay.relayGet(s)).blob, "cipher-2");

    const box = "client" + Math.random().toString(36).slice(2, 10);
    const sub = await makeSubscription(base, box);
    await relay.relaySubscribe(s, "dev-1", "member-1", sub.json);
    const fan = await relay.relayNotify(s, "opaque-b64", "dev-2");
    assert.deepEqual(fan, { sent: 1, gone: 0 });
    const plain = await decryptPush((await deliveries(base, box))[0].body, sub);
    assert.deepEqual(JSON.parse(plain), { s: s.id, p: "opaque-b64" });

    await relay.relayUnsubscribe(s, "dev-1");
    assert.deepEqual(await relay.relayNotify(s, "opaque-b64"), { sent: 0, gone: 0 });

    const newTok = newToken();
    await relay.relayRotate(s, await sha256Hex(newTok));
    await assert.rejects(() => relay.relayGet(s), /^Error: unauthorised$/);

    const rotated = { id: s.id, token: newTok };
    assert.equal((await relay.relayGet(rotated)).blob, "cipher-2");
    assert.equal(await relay.relayDelete(rotated), true);
    await assert.rejects(() => relay.relayGet(rotated), /^Error: not-found$/);
  });
});

describe("js/relay.js error normalisation", () => {
  test("a stale version throws conflict carrying the current blob", async () => {
    const s = space();
    await relay.relayPut(s, 0, "base");
    await relay.relayPut(s, 1, "theirs");

    await assert.rejects(
      () => relay.relayPut(s, 1, "mine"),
      (err) => {
        assert.equal(err.message, "conflict");
        assert.deepEqual(err.current, { version: 2, blob: "theirs" });
        return true;
      }
    );

    // The documented recovery: merge onto what came back, then retry.
    const retried = await relay.relayPut(s, 2, "merged");
    assert.equal(retried.version, 3);
  });

  test("wrong token is unauthorised, oversized blob is too-large", async () => {
    const s = space();
    await relay.relayPut(s, 0, "hello");
    await assert.rejects(
      () => relay.relayGet({ id: s.id, token: newToken() }),
      /^Error: unauthorised$/
    );
    await assert.rejects(
      () => relay.relayPut(space(), 0, "x".repeat(1024 * 1024 + 1)),
      /^Error: too-large$/
    );
  });

  test("an unreachable relay is offline", async () => {
    const dead = mkdtempSync(join(tmpdir(), "batwa-relay-dead-"));
    copyFileSync(join(RELAY_DIR, "..", "js", "relay.js"), join(dead, "relay.js"));
    writeFileSync(join(dead, "config.js"), `export const relayUrl = () => "http://127.0.0.1:9";\n`);
    const mod = await import(pathToFileURL(join(dead, "relay.js")).href);
    await assert.rejects(() => mod.relayGet(space()), /^Error: offline$/);
    try { rmSync(dead, { recursive: true, force: true }); } catch {}
  });
});
