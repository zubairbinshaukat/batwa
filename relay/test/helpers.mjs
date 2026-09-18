// Shared plumbing for the relay test suite: boot `wrangler dev` locally, talk
// to it, and decrypt an aes128gcm push body the way a browser would.

import { spawn } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";

export const RELAY_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(RELAY_DIR, "node_modules", "wrangler", "bin", "wrangler.js");

// A throwaway VAPID pair. Generated once for the suite; never used anywhere else.
export const VAPID_PUBLIC =
  "BBhI-AMK7Ol3bAaCKmHsQZQYVN82ICMZQcO0RvUabk5aSgqjTKzPVqs12_NSG2mM46ioE-b40Aa6NYnyu0MS8BI";
export const VAPID_PRIVATE = "14sMA6UuSm_7B9K8_jVx98mQ7O68KCzXhV7boiuDYuY";

const enc = new TextEncoder();

export function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
export function unb64url(s) {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** 22-char base64url = 128 bits, the space id shape the relay accepts. */
export function newSpaceId() {
  return b64url(crypto.getRandomValues(new Uint8Array(16))).slice(0, 22);
}
export function newToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Buffer.from(d).toString("hex");
}

/** Start `wrangler dev --local` on `port` and wait until it answers. */
export async function startWorker(port, { persistSuffix = "" } = {}) {
  const persist = join(RELAY_DIR, ".wrangler", "test-state" + persistSuffix);
  try { rmSync(persist, { recursive: true, force: true }); } catch {}

  const child = spawn(
    process.execPath,
    [
      WRANGLER, "dev",
      "--local",
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--inspector-port", "0",
      "--persist-to", persist,
      "--log-level", "warn",
      "--var", "TEST_MODE:1",
      "--var", "ALLOWED_ORIGIN:http://127.0.0.1:5173",
      "--var", `VAPID_PUBLIC_KEY:${VAPID_PUBLIC}`,
      "--var", `VAPID_PRIVATE_KEY:${VAPID_PRIVATE}`,
      "--var", "VAPID_SUBJECT:mailto:test@example.com",
    ],
    { cwd: RELAY_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } }
  );

  let log = "";
  const sink = (d) => {
    log += d;
    if (process.env.DEBUG_WRANGLER) process.stderr.write(d);
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("wrangler dev exited early:\n" + log);
    try {
      const res = await fetch(base + "/v1/space/" + newSpaceId(), { headers: { "X-Space-Token": "x" } });
      if (res.status === 404 || res.status === 401) break;
    } catch {}
    if (Date.now() > deadline) {
      stopWorker(child);
      throw new Error("wrangler dev did not come up in 120s:\n" + log);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { child, base, log: () => log };
}

export function stopWorker(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  }
  try { child.kill("SIGTERM"); } catch {}
}

/** A fake browser PushSubscription pointing at the worker's own test route. */
export async function makeSubscription(base, box) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: kp.privateKey,
    publicKey: p256dh,
    authSecret: auth,
    json: {
      endpoint: `${base}/__test/push/${box}`,
      keys: { p256dh: b64url(p256dh), auth: b64url(auth) },
    },
  };
}

function concat(...parts) {
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function hkdf(salt, ikm, info, len) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, Uint8Array.of(1)));
  return okm.slice(0, len);
}

/** The receiving half of RFC 8291 — proves the relay encrypted it properly. */
export async function decryptPush(bodyBytes, sub) {
  const body = Buffer.from(bodyBytes);
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = new Uint8Array(body.subarray(21, 21 + idlen));
  const ciphertext = body.subarray(21 + idlen);

  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, sub.privateKey, 256)
  );
  const keyInfo = concat(enc.encode("WebPush: info\0"), sub.publicKey, asPublic);
  const ikm = await hkdf(sub.authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, ciphertext)
  );
  // strip the RFC 8188 padding delimiter (0x02 on the last record)
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  return Buffer.from(plain.subarray(0, end - 1)).toString("utf8");
}

export async function deliveries(base, box) {
  const res = await fetch(`${base}/__test/pushed/${box}`);
  const body = await res.json();
  return body.deliveries || [];
}
