// Fixtures for js/crypto.js and js/spaces/crypto.js — run with:
//   node --test test/crypto.test.mjs
//
// The regression this guards: base64 used to be `String.fromCharCode(...bytes)`,
// which throws "Maximum call stack size exceeded" once the ciphertext passes
// roughly 120 KB — about 500 ledger entries — so every save after that failed.

import test from "node:test";
import assert from "node:assert/strict";
import { b64, unb64, importAesKey, encrypt, decrypt, deriveKey, randomSalt } from "../js/crypto.js";
import { createSpaceKeys, encryptBlob, decryptBlob } from "../js/spaces/crypto.js";

const entry = (i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  kind: i % 5 ? "expense" : "income",
  title: `Groceries at Imtiaz #${i}`,
  amount: 500 + (i % 997),
  category: "Food",
  recurrence: "one-time",
  status: "paid",
  note: i % 3 ? "" : "split with Ali",
  createdAt: new Date(Date.UTC(2026, 0, 1) + i * 3600e3).toISOString(),
  paidAt: new Date(Date.UTC(2026, 0, 1) + i * 3600e3).toISOString(),
  accountId: "11111111-2222-4333-8444-555555555555",
  seriesId: null,
  isAdjustment: false,
});

test("base64 round-trips every byte value, at every size", () => {
  for (const n of [0, 1, 2, 3, 0x7fff, 0x8000, 0x8001, 200_000, 1_500_000]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const text = b64(bytes);
    assert.equal(text, Buffer.from(bytes).toString("base64"), `encode ${n}`);
    assert.deepEqual(unb64(text), bytes, `decode ${n}`);
  }
  // ArrayBuffer in, not only Uint8Array
  const buf = new Uint8Array([1, 2, 250]).buffer;
  assert.equal(b64(buf), "AQL6");
});

test("a 5,000-entry ledger encrypts and decrypts (it used to fail at ~500)", async () => {
  const key = await importAesKey(crypto.getRandomValues(new Uint8Array(32)));
  const ledger = { entries: Array.from({ length: 5000 }, (_, i) => entry(i)), accounts: [], spaces: [] };
  const sealed = await encrypt(key, ledger);
  assert.ok(sealed.ct.length > 1_000_000, "well past the old limit");
  const back = await decrypt(key, sealed);
  assert.deepEqual(back, ledger);
});

test("the same ledger opens under a PIN-derived key, and not under another PIN", async () => {
  const salt = randomSalt();
  const key = await deriveKey("4455", salt);
  const sealed = await encrypt(key, { entries: Array.from({ length: 800 }, (_, i) => entry(i)) });
  assert.equal((await decrypt(await deriveKey("4455", salt), sealed)).entries.length, 800);
  await assert.rejects(async () => decrypt(await deriveKey("1234", salt), sealed));
});

test("a shared-space blob near the relay's 1 MiB ceiling round-trips", async () => {
  const { key } = createSpaceKeys();
  const blob = { v: 1, name: "Home", entries: Array.from({ length: 2500 }, (_, i) => ({ ...entry(i), participants: {} })) };
  const cipher = await encryptBlob(key, blob);
  assert.ok(cipher.length > 500_000);
  assert.deepEqual(await decryptBlob(key, cipher), blob);
});
