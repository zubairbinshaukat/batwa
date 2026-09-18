// Push notification summaries for shared spaces (plan §7.2 / §7.3).
//
// A summary is the *only* thing that ever leaves the phone in a push payload,
// and it is encrypted with the space's `notifKey` before it does. The relay
// wraps our opaque base64 in `{ s: spaceId, p: payload }` and hands that to the
// push service; the service worker unwraps it, finds the key in IDB meta
// `notifKeys[spaceId]` and turns it back into two strings.
//
// The rules that matter:
//   • never an account name, never a member id, never a note;
//   • one payload is fanned out to every other member, so the text must read
//     the same for all of them (see the `n` note on shareLine below);
//   • if anything at all goes wrong on the way back, the worker falls back to
//     "New activity in a shared space" — a summary is never load-bearing.
//
// This module is pure and import-free: it runs in the page, in Node fixtures
// and (as a hand-copied duplicate of `summaryText`) inside `sw.js`, which
// cannot import an ES module. This file is the canonical copy of that text.

const te = new TextEncoder();
const td = new TextDecoder();

/** The event kinds a summary can describe. Anything else is not sent. */
export const SUMMARY_KINDS = ["split", "settle", "accept", "reject", "edit", "nudge", "join", "leave"];

/* ============================================================
   Codec — a summary is a tiny object, kept tiny on purpose
   ============================================================ */

const str = (v, max = 80) => String(v ?? "").trim().slice(0, max);

/**
 * Normalise a summary into the exact wire shape:
 * `{ t, space, by, title, amount, n }`. Unknown keys are dropped, empty ones
 * are left out entirely so the ciphertext stays small.
 */
export function encodeSummary(summary) {
  const s = summary || {};
  const t = SUMMARY_KINDS.includes(s.t) ? s.t : null;
  if (!t) throw new Error("bad-summary");
  const out = { t };
  const space = str(s.space, 40);
  const by = str(s.by, 40);
  const title = str(s.title, 60);
  if (space) out.space = space;
  if (by) out.by = by;
  if (title) out.title = title;
  const amount = Number(s.amount);
  if (Number.isFinite(amount) && amount !== 0) out.amount = Math.round(amount);
  const n = Number(s.n);
  if (Number.isFinite(n) && n > 0) out.n = Math.round(n);
  return out;
}

/** The inverse: tolerant of anything, because it parses attacker-reachable JSON. */
export function decodeSummary(obj) {
  const s = obj && typeof obj === "object" ? obj : {};
  const amount = Number(s.amount);
  const n = Number(s.n);
  return {
    t: SUMMARY_KINDS.includes(s.t) ? s.t : null,
    space: str(s.space, 40),
    by: str(s.by, 40),
    title: str(s.title, 60),
    amount: Number.isFinite(amount) ? Math.round(amount) : 0,
    n: Number.isFinite(n) && n > 0 ? Math.round(n) : 0,
  };
}

/* ============================================================
   Text — CANONICAL COPY. `sw.js` carries a hand-made duplicate
   (a classic worker has no imports); change both together.
   ============================================================ */

function money(amount, locale) {
  const n = Math.round(Number(amount) || 0);
  let text;
  try { text = new Intl.NumberFormat(locale || "en-PK", { maximumFractionDigits: 0 }).format(n); }
  catch { text = String(n); }
  return `Rs ${text}`;
}

const dot = (...parts) => parts.filter(Boolean).join(" · ");

/**
 * `{ title, body }` for a decoded summary (§7.3):
 *   title "Faraz split Dinner · Rs 3,000"
 *   body  "Split 3 ways · Home"
 *
 * `n` is the number of people the entry was split between. One ciphertext
 * reaches everyone, so the body can only say something that is true for all of
 * them: a per-recipient share would be a lie on a custom split. The count is
 * always right, and the card in the app is the authority anyway — this is a
 * banner, never a figure to act on.
 */
export function summaryText(summary, { locale = "en-PK" } = {}) {
  const s = decodeSummary(summary);
  const who = s.by || "Someone";
  const what = s.title || "an entry";
  const where = s.space || "a shared space";
  const total = s.amount ? money(s.amount, locale) : "";
  const share = s.amount && s.n > 1 ? money(Math.round(s.amount / s.n), locale) : "";
  const shareLine = share ? `Your share ${share}` : total;
  const splitLine = s.n > 1 ? `Split ${s.n} ways` : total;

  switch (s.t) {
    case "split":
      return { title: dot(`${who} split ${what}`, total), body: dot(splitLine, where) };
    case "edit":
      return { title: dot(`${who} changed ${what}`, total), body: dot(shareLine, where) };
    case "settle":
      return { title: `${who} sent ${total || "money"}`, body: dot("Settlement", where) };
    case "accept":
      return { title: `${who} accepted ${what}`, body: dot(total, where) };
    case "reject":
      return { title: `${who} rejected ${what}`, body: dot(total, where) };
    case "nudge":
      return { title: `${who} is waiting on ${what}`, body: dot(total, where) };
    case "join":
      return { title: `${who} joined ${where}`, body: s.n ? `${s.n} members now` : "Shared space" };
    case "leave":
      return { title: `${who} left ${where}`, body: s.n ? `${s.n} members now` : "Shared space" };
    default:
      return { title: "Batwa", body: "New activity in a shared space" };
  }
}

/* ============================================================
   Sealing — the same AES-GCM { iv, ct } layout as js/crypto.js
   ============================================================ */

function bytes(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return unb64(String(raw)); // base64 or base64url — bundles store base64url
}

function b64(buf) {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function unb64(text) {
  const s = String(text).replaceAll("-", "+").replaceAll("_", "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const subtle = () => globalThis.crypto.subtle;

function aesKey(rawKeyBytes, usage) {
  return subtle().importKey("raw", bytes(rawKeyBytes), { name: "AES-GCM" }, false, [usage]);
}

/**
 * Encrypt a summary with a space's raw notification key.
 * Returns base64 of `{"iv":…,"ct":…}` — the opaque string `relayNotify` posts.
 */
export async function sealSummary(rawKeyBytes, summary) {
  const key = await aesKey(rawKeyBytes, "encrypt");
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv },
    key,
    te.encode(JSON.stringify(encodeSummary(summary)))
  );
  return b64(te.encode(JSON.stringify({ iv: b64(iv), ct: b64(ct) })));
}

/** The inverse. Throws on a wrong key, a damaged payload or anything non-JSON. */
export async function openSummary(rawKeyBytes, payloadB64) {
  const wrapper = JSON.parse(td.decode(unb64(payloadB64)));
  if (!wrapper || typeof wrapper.iv !== "string" || typeof wrapper.ct !== "string") {
    throw new Error("bad-payload");
  }
  const key = await aesKey(rawKeyBytes, "decrypt");
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: unb64(wrapper.iv) },
    key,
    unb64(wrapper.ct)
  );
  return decodeSummary(JSON.parse(td.decode(pt)));
}
