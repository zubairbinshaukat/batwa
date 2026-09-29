// PBKDF2 (150k iterations) -> AES-GCM 256. Web Crypto only.
// Wrong PIN = GCM auth failure = data mathematically unreadable.

const ITERATIONS = 150000;

const te = new TextEncoder();
const td = new TextDecoder();

/*
 * Bytes <-> base64, in chunks. `String.fromCharCode(...bytes)` passes every
 * byte as its own argument, and engines cap how many arguments a call may
 * take: past roughly 120 KB of ciphertext (about 500 ledger entries) it threw
 * "Maximum call stack size exceeded" and every save failed. 32 KB per call
 * stays far below any engine's limit and is just as fast.
 */
const CHUNK = 0x8000;

export function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomSalt() {
  return b64(crypto.getRandomValues(new Uint8Array(16)));
}

/** Derive an AES-GCM key from a PIN + base64 salt. */
export async function deriveKey(pin, saltB64) {
  const material = await crypto.subtle.importKey(
    "raw", te.encode(String(pin)), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: unb64(saltB64), iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Same PBKDF2 as deriveKey, but hands back the raw 32 bytes.
 * Only used where the key has to be wrapped by something else (biometrics);
 * the bytes are zeroed by the caller the moment the wrap is done.
 */
export async function deriveKeyBits(pin, saltB64) {
  const material = await crypto.subtle.importKey(
    "raw", te.encode(String(pin)), "PBKDF2", false, ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unb64(saltB64), iterations: ITERATIONS, hash: "SHA-256" },
    material,
    256
  );
}

/** Raw 32 bytes -> AES-GCM key. Non-extractable unless asked otherwise. */
export function importAesKey(rawBytes, { extractable = false } = {}) {
  return crypto.subtle.importKey(
    "raw", rawBytes, { name: "AES-GCM" }, extractable, ["encrypt", "decrypt"]
  );
}

/** HKDF-SHA256 over arbitrary input keying material -> AES-GCM-256, non-extractable. */
export async function hkdfAesKey(ikmBytes, infoStr, saltBytes) {
  const ikm = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: te.encode(infoStr) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt any JSON-serializable value -> { iv, ct } (base64). */
export async function encrypt(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    te.encode(JSON.stringify(data))
  );
  return { iv: b64(iv), ct: b64(ct) };
}

/** Decrypt { iv, ct } -> value. Throws on wrong key. */
export async function decrypt(key, payload) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(payload.iv) },
    key,
    unb64(payload.ct)
  );
  return JSON.parse(td.decode(pt));
}
