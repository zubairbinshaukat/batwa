// Web Push with nothing but Web Crypto.
//
//   RFC 8291 — "Message Encryption for Web Push" (aes128gcm)
//   RFC 8188 — the aes128gcm content coding
//   RFC 8292 — VAPID (a signed JWT identifying the sender)
//
// The relay never sees the plaintext of a notification either: the app has
// already encrypted the summary with its own per-space notification key, and
// the bytes below are just that opaque string wrapped for the push service.

const enc = new TextEncoder();

export function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = "";
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hmac(keyBytes, data) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF (RFC 5869) with a single-block expand, which is all Web Push needs. */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, Uint8Array.of(1)));
  return okm.slice(0, length);
}

/**
 * Encrypt `plaintext` for a browser PushSubscription per RFC 8291.
 * Returns the full aes128gcm body (header + single record).
 */
export async function encryptPayload(plaintext, p256dhB64, authB64) {
  const uaPublic = b64urlToBytes(p256dhB64);   // 65 bytes, uncompressed point
  const authSecret = b64urlToBytes(authB64);   // 16 bytes
  const data = typeof plaintext === "string" ? enc.encode(plaintext) : plaintext;

  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256)
  );

  // PRK_key / IKM, RFC 8291 §3.3
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // One record: plaintext || 0x02 (last-record delimiter), then AES-128-GCM.
  const record = concat(data, Uint8Array.of(2));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, record)
  );

  // RFC 8188 header: salt(16) | rs(4, BE) | idlen(1) | keyid(asPublic, 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, Uint8Array.of(asPublic.length), asPublic, ct);
}

/** Import a raw base64url VAPID key pair (web-push's format) for ES256. */
async function importVapidKey(privateKeyB64, publicKeyB64) {
  const d = b64urlToBytes(privateKeyB64);
  const pub = b64urlToBytes(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("bad-vapid-public-key");
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: bytesToB64url(d),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** RFC 8292 §2: an ES256 JWT over { aud, exp, sub }. */
export async function vapidHeader(endpoint, { publicKey, privateKey, subject }) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(
    enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }))
  );
  const signingInput = `${header}.${claims}`;
  const key = await importVapidKey(privateKey, publicKey);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput))
  );
  const jwt = `${signingInput}.${bytesToB64url(sig)}`;
  return `vapid t=${jwt}, k=${publicKey}`;
}

/**
 * Send one push. Returns the HTTP status from the push service so the caller
 * can prune 404/410 subscriptions. Never throws on a non-2xx.
 */
export async function sendPush(subscription, plaintext, vapid, { ttl = 2419200 } = {}) {
  const body = await encryptPayload(plaintext, subscription.keys.p256dh, subscription.keys.auth);
  const authorization = await vapidHeader(subscription.endpoint, vapid);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "normal",
    },
    body,
  });
  return res.status;
}
