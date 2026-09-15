// Refresh-safe sessions. A page reload must not re-ask for the PIN; closing
// the app must. IndexedDB holds the live (non-extractable) CryptoKey, keyed by
// a random id that lives in sessionStorage — so the key is only reachable from
// the browsing session that unlocked it, and never leaves WebCrypto.

import { getMeta, setMeta, dbDel } from "./db.js";

const SS_KEY = "batwa.session";
const SESSION_MAX_MS = 24 * 60 * 60 * 1000; // absolute ceiling; tab restore can revive sessionStorage

// sessionStorage can throw outright (blocked storage / private mode) — treat as "no session".
function ssGet() {
  try { return sessionStorage.getItem(SS_KEY); } catch { return null; }
}
function ssSet(v) {
  try { sessionStorage.setItem(SS_KEY, v); } catch {}
}
function ssDel() {
  try { sessionStorage.removeItem(SS_KEY); } catch {}
}

const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Remember the unlocked key for this browsing session. Best effort — never throws. */
export async function saveSession(key) {
  if (!key) return;
  const id = newId();
  const now = Date.now();
  try {
    // structured clone of a CryptoKey: supported everywhere IDB is, but an old
    // engine that refuses simply means "ask for the PIN again", not an error.
    await setMeta("session", { id, key, mode: "pin", hiddenAt: 0, savedAt: now, expiresAt: now + SESSION_MAX_MS });
    ssSet(id);
  } catch { await clearSession(); }
}

/** The key if this session is still valid, else null (and the record is dropped). */
export async function restoreSession(timeoutMs) {
  const id = ssGet();
  let rec = null;
  try { rec = await getMeta("session"); } catch { rec = null; }
  if (!rec || !id || rec.id !== id) { await clearSession(); return null; }
  const now = Date.now();
  const stale = now >= (rec.expiresAt || 0) || (rec.hiddenAt && now - rec.hiddenAt > timeoutMs);
  if (stale || !rec.key) { await clearSession(); return null; }
  // Restored = visible now. Drop the stamp so a pagehide write that never
  // landed can't lock a later refresh out.
  if (rec.hiddenAt) { try { await setMeta("session", { ...rec, hiddenAt: 0 }); } catch {} }
  return rec.key;
}

/** Start the background clock — the 60s rule survives Chrome killing the tab. */
export async function touchHidden() {
  try {
    const rec = await getMeta("session");
    if (rec && rec.id === ssGet()) await setMeta("session", { ...rec, hiddenAt: Date.now() });
  } catch {}
}

/** Back in the foreground within the timeout: stop the clock. */
export async function touchVisible() {
  try {
    const rec = await getMeta("session");
    if (rec && rec.id === ssGet() && rec.hiddenAt) await setMeta("session", { ...rec, hiddenAt: 0 });
  } catch {}
}

export async function clearSession() {
  ssDel();
  try { await dbDel("meta", "session"); } catch {}
}
