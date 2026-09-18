// Keys and invite codes for shared spaces.
//
// The relay is zero-knowledge, so everything that makes a space readable lives
// here and travels only inside an invite or inside the PIN-encrypted ledger:
//
//   id       16 random bytes -> 22-char base64url. The relay's only handle.
//   token    32 random bytes. The write password; the relay stores sha256 of it.
//   key      32 random bytes -> AES-GCM-256 for the space blob.
//   notifKey 32 random bytes -> AES-GCM-256 for push summaries (§7).
//
// The invite code is `v1|id|token|key|notifKey|name` base64url-encoded, so a
// single string (or one QR) carries everything a new member needs. Anyone
// holding it can read and write the space — that is the documented model.

import { b64, unb64, importAesKey, encrypt, decrypt } from "../crypto.js";

const te = new TextEncoder();
const td = new TextDecoder();

/* ---- base64url helpers (the relay's id alphabet, and the invite's) ---- */

export function b64url(bytes) {
  return b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unb64url(str) {
  const s = String(str).replaceAll("-", "+").replaceAll("_", "/");
  return unb64(s + "=".repeat((4 - (s.length % 4)) % 4));
}

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

/** 22-char base64url = 128 bits, the exact id shape the relay accepts. */
export const SPACE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** sha256 of a string, lowercase hex — the form `POST /rotate` wants. */
export async function sha256Hex(str) {
  const d = await crypto.subtle.digest("SHA-256", te.encode(String(str)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fresh keys for a brand-new space (or for a rotation). */
export function createSpaceKeys() {
  return {
    id: b64url(rand(16)),
    token: b64url(rand(32)),
    key: b64url(rand(32)),
    notifKey: b64url(rand(32)),
  };
}

/** A random member id — opaque, per space, never reused across spaces. */
export function newMemberId() {
  return b64url(rand(9)); // 12 chars, plenty inside a single space
}

/** The AES-GCM key for a space's blob. Non-extractable, imported per call site. */
export function spaceKey(keyB64url) {
  return importAesKey(unb64url(keyB64url));
}

/** Encrypt a space blob -> the opaque string the relay stores. */
export async function encryptBlob(keyB64url, blob) {
  const key = await spaceKey(keyB64url);
  return JSON.stringify(await encrypt(key, blob));
}

/** Decrypt what the relay handed back. Throws on a wrong key or damaged text. */
export async function decryptBlob(keyB64url, cipherString) {
  const key = await spaceKey(keyB64url);
  const payload = typeof cipherString === "string" ? JSON.parse(cipherString) : cipherString;
  return decrypt(key, payload);
}

/* ============================================================
   Invite codec
   ============================================================ */

const INVITE_V = "v1";

/**
 * `v1|id|token|key|notifKey|name` -> base64url. The name is percent-encoded
 * first, so a `|` or any non-ASCII character in a space name survives the trip
 * (fixture covers Urdu and emoji names).
 */
export function encodeInvite({ id, token, key, notifKey, name }) {
  const parts = [INVITE_V, id, token, key, notifKey, encodeURIComponent(String(name ?? ""))];
  return b64url(te.encode(parts.join("|")));
}

/**
 * The inverse. Throws Error("bad-code") for anything that is not a v1 invite —
 * callers turn that into "That invite isn't valid".
 */
export function decodeInvite(code) {
  let text;
  try {
    text = td.decode(unb64url(String(code).trim()));
  } catch {
    throw new Error("bad-code");
  }
  const parts = text.split("|");
  if (parts.length !== 6 || parts[0] !== INVITE_V) throw new Error("bad-code");
  const [, id, token, key, notifKey, rawName] = parts;
  if (!SPACE_ID_RE.test(id)) throw new Error("bad-code");
  for (const secret of [token, key, notifKey]) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("bad-code");
  }
  let name;
  try { name = decodeURIComponent(rawName); } catch { throw new Error("bad-code"); }
  return { id, token, key, notifKey, name };
}

/** The shareable link form of an invite, relative to wherever the app is served. */
export function inviteLink(code, origin = location.origin + location.pathname.replace(/[^/]*$/, "")) {
  return `${origin}?join=${code}`;
}
