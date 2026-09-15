// Fingerprint unlock = WebAuthn PRF. The platform authenticator hands back a
// secret derived from the credential; HKDF turns it into an AES key that wraps
// a copy of the PIN key. No PRF, no enrolment — a fingerprint that only gates
// the UI while the key sits in the clear would be security theatre.
//
// Everything here speaks raw key BYTES. auth.js imports them as a
// non-extractable key and checks them against pinVerifier before trusting them.

import { getMeta, setMeta, dbDel } from "./db.js";
import { b64, unb64, encrypt, decrypt, hkdfAesKey } from "./crypto.js";

const LS_KEY = "batwa.bio";
const WRAP_INFO = "batwa/bio-wrap/v1";
const TIMEOUT = 60000;
const RP_NAME = "Batwa";

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

function lsSet(v) { try { localStorage.setItem(LS_KEY, v); } catch {} }
function lsDel() { try { localStorage.removeItem(LS_KEY); } catch {} }

/** Sync hint for the very first paint, before IndexedDB has answered. */
export function bioHint() {
  try { return localStorage.getItem(LS_KEY) === "1"; } catch { return false; }
}

/** Cheap synchronous gate — is there any point asking the platform at all. */
export function bioSupportedSync() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!window.isSecureContext;
}

let _avail = null;
/**
 * Does this device have a user-verifying platform authenticator we can use.
 * getClientCapabilities reports what the CLIENT supports; whether the
 * authenticator itself does PRF is only known from prf.enabled at create().
 */
export async function bioAvailable() {
  if (_avail !== null) return _avail;
  _avail = await (async () => {
    if (!bioSupportedSync()) return false;
    try {
      if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return false;
    } catch { return false; }
    try {
      const caps = await PublicKeyCredential.getClientCapabilities?.();
      if (caps && caps["extension:prf"] === false) return false;
    } catch { /* not implemented — fall through, create() decides */ }
    return true;
  })();
  return _avail;
}

export async function isBioEnrolled() {
  try { return !!(await getMeta("bio")); } catch { return false; }
}

/** Best-effort cleanup of a passkey we can't use. Never throws, never rejects. */
function forget(credIdB64) {
  // the signal API speaks base64url, our storage speaks plain base64
  const id = credIdB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    PublicKeyCredential.signalUnknownCredential?.({ rpId: location.hostname, credentialId: id })
      ?.catch(() => {});
  } catch {}
}

/**
 * Create the passkey and wrap `pinKeyBits` with its PRF output.
 * MUST be called straight from a user tap — Chrome requires user activation.
 * Android usually needs a second prompt because create() returns
 * prf.enabled without prf.results; Chrome 147+ returns results directly.
 */
export async function enrollBio(pinKeyBits) {
  if (!(await bioAvailable())) {
    return { ok: false, code: "unsupported", reason: "This device has no fingerprint Batwa can use" };
  }
  const prfSalt = rand(32);
  const userId = rand(16);
  const existing = await getMeta("bio").catch(() => null);
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        // No rp.id — it defaults to this origin's domain, which is what we want
        // on GitHub Pages, Netlify and localhost alike.
        rp: { name: RP_NAME },
        user: { id: userId, name: "batwa", displayName: RP_NAME },
        challenge: rand(32),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "required",
          requireResidentKey: true, // legacy flag Android's FIDO stack still reads
          userVerification: "required",
        },
        hints: ["client-device"],
        timeout: TIMEOUT,
        attestation: "none",
        excludeCredentials: existing?.credId
          ? [{ type: "public-key", id: unb64(existing.credId), transports: ["internal"] }]
          : [],
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
  } catch (err) {
    return failure(err);
  }
  if (!cred) return { ok: false, code: "cancel", reason: "Nothing was set up" };

  const credId = b64(cred.rawId);
  const ext = cred.getClientExtensionResults?.() || {};
  if (!ext.prf?.enabled) {
    forget(credId);
    return {
      ok: false, code: "unsupported",
      reason: "This phone's fingerprint can't protect a key (PRF isn't supported)",
    };
  }

  let prfOut = ext.prf.results?.first;
  if (!prfOut) {
    // The common Android case: enabled at create, value only at get.
    try {
      const asrt = await navigator.credentials.get({
        publicKey: {
          challenge: rand(32),
          allowCredentials: [{ type: "public-key", id: cred.rawId, transports: ["internal"] }],
          userVerification: "required",
          hints: ["client-device"],
          timeout: TIMEOUT,
          extensions: { prf: { eval: { first: prfSalt } } },
        },
      });
      prfOut = asrt?.getClientExtensionResults?.().prf?.results?.first;
    } catch (err) {
      forget(credId);
      return failure(err);
    }
  }
  if (!prfOut) {
    forget(credId);
    return { ok: false, code: "unsupported", reason: "The fingerprint didn't return a key — nothing was set up" };
  }

  const prfBytes = new Uint8Array(prfOut);
  try {
    const wrapKey = await hkdfAesKey(prfBytes, WRAP_INFO, prfSalt);
    const wrapped = await encrypt(wrapKey, b64(pinKeyBits));
    await setMeta("bio", {
      v: 1,
      credId,
      userId: b64(userId),
      prfSalt: b64(prfSalt),
      wrapped,
      createdAt: new Date().toISOString(),
      transports: cred.response?.getTransports?.() || [],
    });
    await setMeta("bioFails", 0);
    lsSet("1");
    return { ok: true };
  } catch {
    return { ok: false, code: "corrupt", reason: "Couldn't store the fingerprint key" };
  } finally {
    prfBytes.fill(0);
  }
}

/** Ask the fingerprint sheet for the PIN key bytes back. */
export async function unwrapWithBio() {
  const rec = await getMeta("bio").catch(() => null);
  if (!rec?.wrapped) return { ok: false, code: "gone", reason: "Fingerprint unlock isn't set up", elapsedMs: 0 };
  const prfSalt = unb64(rec.prfSalt);
  const t0 = Date.now();
  let asrt;
  try {
    asrt = await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        // The stored id skips the account chooser: straight to the fingerprint sheet.
        allowCredentials: [{ type: "public-key", id: unb64(rec.credId), transports: ["internal"] }],
        userVerification: "required",
        hints: ["client-device"],
        timeout: TIMEOUT,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
  } catch (err) {
    return { ...failure(err), elapsedMs: Date.now() - t0 };
  }
  const elapsedMs = Date.now() - t0;
  const prfOut = asrt?.getClientExtensionResults?.().prf?.results?.first;
  if (!prfOut) return { ok: false, code: "corrupt", reason: "The fingerprint didn't return the key", elapsedMs };

  const prfBytes = new Uint8Array(prfOut);
  try {
    const wrapKey = await hkdfAesKey(prfBytes, WRAP_INFO, prfSalt);
    const keyBits = unb64(await decrypt(wrapKey, rec.wrapped));
    return { ok: true, keyBits, elapsedMs };
  } catch {
    return { ok: false, code: "corrupt", reason: "The stored fingerprint key is unreadable", elapsedMs };
  } finally {
    prfBytes.fill(0);
  }
}

/**
 * PIN changed: re-wrap under the new key bits. One native prompt — the PRF
 * output is the same secret that unwrapped the old copy, so there is nothing
 * to verify first. On any failure the enrolment is dropped rather than left
 * pointing at a dead key.
 */
export async function rewrapBio(newPinKeyBits) {
  const rec = await getMeta("bio").catch(() => null);
  if (!rec?.wrapped) return { ok: false, reason: "Fingerprint unlock isn't set up" };
  const prfSalt = unb64(rec.prfSalt);
  const fresh = await prfBytesFor(rec, prfSalt);
  if (!fresh.ok) { await removeBio(); return { ok: false, reason: fresh.reason }; }
  try {
    const wrapKey = await hkdfAesKey(fresh.prfBytes, WRAP_INFO, prfSalt);
    const wrapped = await encrypt(wrapKey, b64(newPinKeyBits));
    await setMeta("bio", { ...rec, wrapped });
    return { ok: true };
  } catch {
    await removeBio();
    return { ok: false, reason: "Couldn't re-wrap the fingerprint key" };
  } finally {
    fresh.prfBytes.fill(0);
  }
}

/** Internal: one get() that yields the PRF bytes themselves (caller zeroes them). */
async function prfBytesFor(rec, prfSalt) {
  try {
    const asrt = await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: "public-key", id: unb64(rec.credId), transports: ["internal"] }],
        userVerification: "required",
        hints: ["client-device"],
        timeout: TIMEOUT,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    const out = asrt?.getClientExtensionResults?.().prf?.results?.first;
    if (!out) return { ok: false, reason: "The fingerprint didn't return the key" };
    return { ok: true, prfBytes: new Uint8Array(out) };
  } catch (err) {
    return failure(err);
  }
}

/** Forget the enrolment. Never needs the PIN — it only deletes a wrapped copy. */
export async function removeBio({ signal = true } = {}) {
  const rec = await getMeta("bio").catch(() => null);
  try { await dbDel("meta", "bio"); } catch {}
  try { await setMeta("bioFails", 0); } catch {}
  lsDel();
  if (signal && rec?.credId) forget(rec.credId);
}

/**
 * WebAuthn deliberately refuses to tell cancel, timeout, missing gesture and
 * "credential deleted" apart — they are all NotAllowedError. Callers use
 * elapsedMs to guess whether a prompt was ever shown.
 */
function failure(err) {
  const name = err?.name || "";
  if (name === "SecurityError" || name === "NotSupportedError") {
    return { ok: false, code: "unsupported", reason: "This browser can't use the fingerprint here" };
  }
  if (name === "InvalidStateError") {
    return { ok: false, code: "cancel", reason: "This device already has a Batwa fingerprint" };
  }
  return { ok: false, code: "cancel", reason: "Fingerprint wasn't confirmed" };
}
