// Shared spaces: the bundles, the sync loop, and every mutation the UI makes.
//
// A space is two halves that never meet on the wire:
//   • the bundle (id, token, key, notifKey, name, colour, my member id) lives
//     inside the PIN-encrypted personal ledger as `state.spaces`, so it is in
//     backups and follows the user to a second phone via personal sync;
//   • the blob (members, entries, tombstones) lives on the relay as ciphertext
//     only, cached here in IDB meta `spaceBlob:<id>` so the space screen works
//     offline.
//
// The loop never re-renders the page: pulls emit through onSpacesChange and,
// for the ledger, `emit({ silent: true })`. A background pull must not yank a
// half-scrolled list or an open sheet out from under anyone (plan §9.29).

import { getMeta, setMeta, dbDel } from "./db.js";
import {
  state, saveSpaces, setSharedRows, rowsForShared, writeRows,
  outstandingOf, stillOwedOf, partialOf, isWriteoff,
} from "./ledger.js";
import { uuid } from "./util/dom.js";
import {
  relayGet, relayPut, relayHead, relayRotate, relayDelete,
  relaySubscribe, relayUnsubscribe, relayNotify,
} from "./relay.js";
import { relayUrl, VAPID_PUBLIC_KEY } from "./config.js";
import {
  createSpaceKeys, newMemberId, encodeInvite, decodeInvite, encryptBlob, decryptBlob,
  sha256Hex,
} from "./spaces/crypto.js";
import {
  emptyBlob, mergeBlobs, normaliseBlob, netPosition, nameTaken, suggestName, initialsOf,
  splitEqually, compactionDue, compactionPlan, applyCompaction, blobBytes,
  staleMembers, needsNewInvite, isCompacted, MAX_BLOB_BYTES, STALE_DAYS,
} from "./spaces/merge.js";
import { encodeSummary, sealSummary } from "./spaces/notify.js";
import {
  pushSupported, pushState, subscribePush, unsubscribePush, currentSubscription, deviceId,
} from "./ui/pushsetup.js";

// Pure blob helpers live in merge.js so the Node fixtures can reach them; the
// rest of the app imports them from here, where the rest of spaces lives.
export { nameTaken, suggestName, initialsOf, splitEqually, STALE_DAYS };

/* ============================================================
   Palette
   ============================================================ */

/** Space colours. The name is what the bundle stores; the hex is derived. */
export const SPACE_COLORS = {
  violet: "#6248F5",
  aqua:   "#2FB6E9",
  mint:   "#12B77F",
  amber:  "#E8930C",
  rose:   "#EF4667",
  indigo: "#4630C9",
};

/** Member avatar colours — distinct enough to tell three people apart. */
export const MEMBER_COLORS = {
  violet: "#6248F5",
  aqua:   "#2FB6E9",
  mint:   "#12B77F",
  amber:  "#E8930C",
  rose:   "#EF4667",
  plum:   "#9B59D0",
};

export const colorHex = (name, map = SPACE_COLORS) => map[name] || map.violet;

/* ============================================================
   In-memory state
   ============================================================ */

/** id -> decrypted blob, merged with anything this phone has not pushed yet. */
const blobs = new Map();
/** id -> "ok" | "expired" | "gone" | "offline" | "syncing" */
const status = new Map();

const listeners = new Set();
/** Subscribe to space changes. The callback gets `{ id, reason }`. */
export function onSpacesChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emitSpaces(id, reason) {
  const detail = { id: id || null, reason: reason || "change" };
  for (const cb of [...listeners]) { try { cb(detail); } catch (e) { console.error(e); } }
}

/**
 * Resolves once initSpaces() has restored the cached blobs, so a deep link can
 * ask "is anything pending here?" and get a truthful answer rather than the
 * empty one an un-loaded cache would give (plan 9.28).
 */
let markReady;
const readyPromise = new Promise((r) => { markReady = r; });
export const spacesReady = () => readyPromise;

export const spaces = () => state.spaces || [];
export const getSpace = (id) => (state.spaces || []).find((s) => s.id === id) || null;
export const blobOf = (id) => blobs.get(id) || null;
export const spaceStatus = (id) => status.get(id) || (getSpace(id)?.status ?? "ok");
export const relayConfigured = () => !!relayUrl();

/** Everything the shared UI keys off: no bundles, no shared anything (§0). */
export const hasSpaces = () => (state.spaces || []).length > 0;

/* ============================================================
   Persistence
   ============================================================ */

const cacheKey = (id) => `spaceBlob:${id}`;

async function cacheBlob(space, blob) {
  try {
    await setMeta(cacheKey(space.id), {
      version: space.lastVersion ?? 0,
      cipher: await encryptBlob(space.key, blob),
    });
  } catch (err) {
    console.warn("space cache write failed", err);
  }
}

async function loadCachedBlob(space) {
  try {
    const rec = await getMeta(cacheKey(space.id));
    if (!rec || !rec.cipher) return null;
    return normaliseBlob(await decryptBlob(space.key, rec.cipher));
  } catch {
    return null; // a rotated key makes the old cache unreadable; that's fine
  }
}

/* ------------------------------------------------------------
   The local archive (plan §8)
   ------------------------------------------------------------
   Compaction takes the old, fully-answered entries out of the SHARED blob so
   three phones stop merging a year of history forever. It does not throw them
   away: before the compacted blob is pushed, every phone writes the removed
   detail into its own `spaceArchive:<id>` — encrypted with the space key, the
   same as the blob cache — so this phone's Records and History keep reading
   exactly what they read yesterday. The archive never leaves the device and is
   never merged; it is one phone's memory of its own past.                     */

const archiveKey = (id) => `spaceArchive:${id}`;
/** id -> SharedEntry[] once read. */
const archives = new Map();

async function loadArchive(space) {
  if (archives.has(space.id)) return archives.get(space.id);
  let list = [];
  try {
    const rec = await getMeta(archiveKey(space.id));
    if (rec && rec.cipher) list = (await decryptBlob(space.key, rec.cipher)) || [];
  } catch {
    list = []; // a rotated key, or a damaged record: the blob is still the truth
  }
  archives.set(space.id, list);
  return list;
}

async function saveArchive(space, list) {
  archives.set(space.id, list);
  try {
    await setMeta(archiveKey(space.id), { cipher: await encryptBlob(space.key, list) });
  } catch (err) {
    console.warn("space archive write failed", err);
  }
}

/** Entries this phone has archived for one space, newest last. Sync, cached. */
export const archivedEntries = (id) => (archives.get(id) || []).slice();

/** Everything the space knows about, blob and archive together. */
export function allEntriesOf(id) {
  const blob = blobs.get(id);
  return [...(archives.get(id) || []), ...((blob && blob.entries) || [])];
}

/**
 * The service worker reads `notifKeys[id]` to decrypt push summaries while the
 * app is locked (§7.4). It is mirrored out of the encrypted bundle only while
 * that space's "Show details" toggle is on, and removed the moment it is off.
 */
async function syncNotifKeys() {
  const map = {};
  for (const s of state.spaces || []) if (s.notifDetails) map[s.id] = s.notifKey;
  await setMeta("notifKeys", map);
}

/* ============================================================
   Bundles
   ============================================================ */

function newBundle({ id, token, key, notifKey, name, color, myMemberId, myName }) {
  return {
    id, token, key, notifKey, name, color,
    myMemberId,
    myName,
    joinedAt: new Date().toISOString(),
    lastVersion: 0,
    dirty: true,
    status: "ok",
    notifDetails: true,
    lastAccountId: null,
    lastCategory: null,
  };
}

/** The invite code for a space I am already in. */
export const inviteCodeFor = (space) => encodeInvite(space);

/** My profile defaults (name + colour), reused for every space I create. */
export const profile = () => state.profile || null;

export async function saveProfile({ name, color }) {
  state.profile = { name: String(name || "").trim(), color: color || "violet" };
  await saveSpaces();
  return state.profile;
}

/* ============================================================
   Derived figures
   ============================================================ */

/**
 * My net position in a space — positive means the others owe me.
 * Write-offs live in my ledger, never in the blob, so they are handed to the
 * pure function rather than found by it (§9.18).
 */
export function netFor(id) {
  const space = getSpace(id);
  const blob = blobs.get(id);
  if (!space || !blob) return { net: 0, perMember: {} };
  return netPosition(blob, space.myMemberId, { writeoffs: writeoffsFor(id) });
}

/** `memberId -> rupees` I have given up on in this space. */
export function writeoffsFor(spaceId) {
  const out = {};
  for (const e of state.entries || []) {
    if (!isWriteoff(e) || e.spaceId !== spaceId || !e.counterpart) continue;
    out[e.counterpart] = (out[e.counterpart] || 0) + (Number(e.amount) || 0);
  }
  return out;
}

/* ------------------------------------------------------------
   Contacts: one human, several spaces (plan §8)
   ------------------------------------------------------------
   A memberId is per space and deliberately meaningless outside it, so there is
   no way for the app to know that "Faraz" in Home and "Faraz" in Trip are the
   same person. The user says so, once, and the link lives in MY ledger only —
   `state.contacts` is inside the encrypted blob and is never pushed to a relay.
   Nothing about the money is joined by it: the transfer sheet folds him into
   one chip with a space sub-chooser, and the switcher shows what he owes me in
   each space side by side. Netting two spaces against each other would invent
   a debt neither space knows about.                                          */

/** Every contact, as `[localContactId, { name, links }]`. */
export const contacts = () => Object.entries(state.contacts || {});

/** The contact this member belongs to, or null. */
export function contactOf(spaceId, memberId) {
  for (const [cid, c] of contacts()) {
    if ((c?.links || []).some((l) => l.spaceId === spaceId && l.memberId === memberId)) {
      return { id: cid, ...c };
    }
  }
  return null;
}

/**
 * Everyone in my OTHER spaces this member could be the same person as — the
 * "Same person as…" list. Anyone already linked to somebody in this space is
 * left out, because one human cannot be two members of one space.
 */
export function linkCandidates(spaceId, memberId) {
  const mine = contactOf(spaceId, memberId);
  const out = [];
  for (const s of spaces()) {
    if (s.id === spaceId) continue;
    for (const m of blobs.get(s.id)?.members || []) {
      if (m.leftAt || m.memberId === s.myMemberId) continue;
      const theirs = contactOf(s.id, m.memberId);
      // Already the same contact -> it is the "unlink" side of the list.
      const linked = !!(mine && theirs && theirs.id === mine.id);
      if (theirs && !linked) continue;       // spoken for by somebody else
      out.push({
        spaceId: s.id, spaceName: s.name, spaceColor: s.color,
        memberId: m.memberId, name: m.name, color: m.color, linked,
      });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Say that two members are one person. Either may already be in a contact, in
 * which case the two contacts are folded into one; `name` defaults to the name
 * the member wears in the space I am looking at.
 */
export async function linkMembers(a, b, name = null) {
  if (!a || !b || a.spaceId === b.spaceId) return null;
  state.contacts = { ...(state.contacts || {}) };
  const ca = contactOf(a.spaceId, a.memberId);
  const cb = contactOf(b.spaceId, b.memberId);
  const id = ca?.id || cb?.id || uuid();
  const links = [];
  const seen = new Set();
  for (const l of [...(ca?.links || []), ...(cb?.links || []), a, b]) {
    const key = `${l.spaceId}:${l.memberId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ spaceId: l.spaceId, memberId: l.memberId });
  }
  if (ca && cb && ca.id !== cb.id) delete state.contacts[cb.id];
  state.contacts[id] = {
    name: String(name || ca?.name || cb?.name || memberNameIn(a.spaceId, a.memberId) || "").trim(),
    links,
  };
  await saveSpaces();
  emitSpaces(a.spaceId, "contacts");
  return { id, ...state.contacts[id] };
}

/** Drop one member out of its contact; a contact with one link left goes too. */
export async function unlinkMember(spaceId, memberId) {
  const c = contactOf(spaceId, memberId);
  if (!c) return false;
  const links = c.links.filter((l) => !(l.spaceId === spaceId && l.memberId === memberId));
  state.contacts = { ...(state.contacts || {}) };
  if (links.length < 2) delete state.contacts[c.id];
  else state.contacts[c.id] = { ...c, links };
  await saveSpaces();
  emitSpaces(spaceId, "contacts");
  return true;
}

/** Rename a contact (the label the transfer sheet and the switcher show). */
export async function renameContact(contactId, name) {
  const c = (state.contacts || {})[contactId];
  if (!c) return null;
  state.contacts = { ...state.contacts, [contactId]: { ...c, name: String(name || "").trim() } };
  await saveSpaces();
  emitSpaces(null, "contacts");
  return state.contacts[contactId];
}

/**
 * The switcher's "Across spaces" line: linked people who have a balance with
 * me in MORE THAN ONE space. Per space, and a total that is a sum on screen
 * only — the money is never moved between spaces (plan §8).
 */
export function acrossSpaces() {
  const out = [];
  for (const [cid, c] of contacts()) {
    const rows = [];
    for (const l of c?.links || []) {
      const space = getSpace(l.spaceId);
      if (!space) continue;
      const v = Math.round(netFor(l.spaceId).perMember?.[l.memberId] || 0);
      if (!v) continue;
      rows.push({ spaceId: space.id, spaceName: space.name, color: space.color, net: v });
    }
    if (rows.length < 2) continue;
    const first = c.links.find((l) => getSpace(l.spaceId));
    out.push({
      id: cid,
      name: c.name || (first ? memberNameIn(first.spaceId, first.memberId) : "Someone"),
      spaces: rows.sort((a, b) => (a.spaceName < b.spaceName ? -1 : 1)),
      total: rows.reduce((t, r) => t + r.net, 0),
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** One member's display name inside one space, or a safe stand-in. */
export function memberNameIn(spaceId, memberId) {
  const space = getSpace(spaceId);
  if (space && memberId === space.myMemberId) return space.myName || "You";
  return (blobs.get(spaceId)?.members || []).find((m) => m.memberId === memberId)?.name || "Someone";
}

export function membersOf(id) {
  return (blobs.get(id)?.members || []).slice();
}

/** Entries where I am a named participant who has not answered yet (M3 fills). */
export function pendingForMe(id) {
  const space = getSpace(id);
  const blob = blobs.get(id);
  if (!space || !blob) return [];
  return (blob.entries || []).filter(
    (e) => e.participants?.[space.myMemberId]?.status === "proposed"
  );
}

/**
 * My proposals that still need something from me or from someone else: either
 * a member has not answered yet, or one rejected and their share is sitting
 * unassigned waiting for me to decide what happens to it (plan §9.10).
 */
export function waitingOnOthers(id) {
  const space = getSpace(id);
  const blob = blobs.get(id);
  if (!space || !blob) return [];
  return (blob.entries || []).filter((e) => {
    if (e.proposedBy !== space.myMemberId) return false;
    const others = Object.entries(e.participants || {}).filter(([m]) => m !== space.myMemberId);
    return others.some(([, p]) => p.status === "proposed") || unassignedOf(e) > 0;
  });
}

/**
 * What a rejection left behind: the shares of everyone who said "not mine".
 * Nobody is paying it until the proposer splits it among the rest or covers it.
 */
export function unassignedOf(entry) {
  let sum = 0;
  for (const [m, p] of Object.entries(entry?.participants || {})) {
    if (p?.status !== "rejected") continue;
    sum += Math.round(Number(entry.split?.shares?.[m]) || 0);
  }
  return sum;
}

export function conflictsIn(id) {
  const blob = blobs.get(id);
  if (!blob) return [];
  return (blob.entries || []).filter((e) => (e.conflicts || []).length);
}

/** Does any space have something waiting for me? Drives the header dot. */
export function anyPending() {
  return (state.spaces || []).some((s) => pendingForMe(s.id).length > 0);
}

/**
 * Everything waiting on me across every space, newest proposal first — the
 * Home "Shared requests" card and the pending sheet read exactly this.
 */
export function allPending() {
  const out = [];
  for (const s of state.spaces || []) {
    for (const entry of pendingForMe(s.id)) out.push({ space: s, entry });
  }
  return out.sort((a, b) =>
    String(b.entry.updatedAt || b.entry.createdAt || "") <
    String(a.entry.updatedAt || a.entry.createdAt || "") ? -1 : 1);
}

/** Any space that could not reach the relay, or whose invite went stale. */
export function anyTrouble() {
  if (hasSpaces() && typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return (state.spaces || []).some((s) => {
    const st = spaceStatus(s.id);
    return st === "expired" || st === "gone" || st === "offline" || st === "too-large";
  });
}

/** Any space with unpushed work sitting in its outbox (plan §9.2, §9.3). */
export const anyQueued = () => (state.spaces || []).some((s) => !!s.dirty);

/* ============================================================
   Sync loop
   ============================================================ */

const PUSH_DEBOUNCE = 1500;
const POLL_MS = 3 * 60 * 1000;
const MAX_RETRY = 5;

const pushTimers = new Map();
let pollTimer = null;
let started = false;

function setStatus(id, value) {
  const prev = status.get(id);
  status.set(id, value);
  const space = getSpace(id);
  if (space && space.status !== value && value !== "syncing") {
    space.status = value;
    saveSpaces().catch(() => {});
  }
  if (prev !== value) emitSpaces(id, "status");
}

/**
 * Bring one space down from the relay and fold it into the local copy.
 * Never throws: a failure is a status, not an exception, because this runs on
 * a timer nobody asked for.
 */
export async function pullSpace(id, { force = false } = {}) {
  const space = getSpace(id);
  if (!space || !relayConfigured()) return false;
  // A space whose invite went stale needs a new code, not another request a
  // minute — the poll leaves it alone until the user re-joins.
  if (!force && (spaceStatus(id) === "expired" || spaceStatus(id) === "gone")) return false;
  try {
    const res = await relayGet(space, { knownVersion: force ? null : space.lastVersion || null });
    if (res.notModified) {
      setStatus(id, space.dirty ? "ok" : "ok");
      if (space.dirty) await pushSpace(id);
      return false;
    }
    const remote = res.blob ? await decryptBlob(space.key, res.blob) : null;
    const before = blobs.get(id) || null;
    const merged = mergeBlobs(before, remote);
    // Something I was holding is not in the merge any more: somebody deleted
    // it while I was editing, and the tombstone won (plan §9.8). My rows for
    // it go, and the surface that asked for the pull is told what vanished.
    const vanished = [];
    if (before) {
      const live = new Set(merged.entries.map((e) => e.id));
      for (const e of before.entries || []) {
        if (live.has(e.id)) continue;
        if (isCompacted(e, merged.compactedBefore)) continue; // archived, not deleted
        vanished.push(e);
      }
    }
    blobs.set(id, merged);
    space.lastVersion = res.version ?? space.lastVersion;
    // Keep the bundle's label in step with the space's own name (someone else
    // may have renamed it); the bundle is what the switcher and settings read.
    const changedLabel = space.name !== merged.name || space.color !== merged.color;
    space.name = merged.name;
    space.color = merged.color;
    // Did our side carry anything the relay had not seen?
    space.dirty = space.dirty || JSON.stringify(merged) !== JSON.stringify(normaliseBlob(remote));
    setStatus(id, "ok");
    await foldArchive(space, before, merged);
    await cacheBlob(space, merged);
    await saveSpaces();
    for (const e of vanished) {
      await setSharedRows(id, e.id, []);
      emitSpaces(id, "removed");
      lastRemoved = { spaceId: id, title: e.title || "an entry", by: memberNameIn(id, e.updatedBy || e.proposedBy) };
    }
    emitSpaces(id, changedLabel ? "renamed" : "pull");
    if (space.dirty) await pushSpace(id);
    return true;
  } catch (err) {
    handleRelayError(id, err);
    return false;
  }
}

/**
 * The last thing a pull discovered had been deleted elsewhere, so app.js can
 * say "Faraz removed this" once (plan §9.8). Read-and-clear.
 */
let lastRemoved = null;
export function takeRemovedNotice() {
  const v = lastRemoved;
  lastRemoved = null;
  return v;
}

/**
 * Somebody else compacted: the entries behind the new line are gone from the
 * blob I just merged, so this phone archives its own copy of them before they
 * are unreachable. Idempotent — an entry already archived is not re-added.
 */
async function foldArchive(space, before, merged) {
  const line = merged?.compactedBefore || null;
  if (!line || !before) return;
  const live = new Set(merged.entries.map((e) => e.id));
  const have = new Set((archives.get(space.id) || []).map((e) => e.id));
  const add = (before.entries || []).filter(
    (e) => !live.has(e.id) && !have.has(e.id) && isCompacted(e, line));
  if (!add.length) return;
  await saveArchive(space, [...(archives.get(space.id) || []), ...add]
    .sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1)));
}

function handleRelayError(id, err) {
  const code = String(err?.message || "");
  if (code === "unauthorised") setStatus(id, "expired");
  else if (code === "not-found") setStatus(id, "gone");
  else if (code === "offline" || code === "not-configured") setStatus(id, "offline");
  else {
    console.warn("space sync", id, code);
    setStatus(id, "offline");
  }
}

/**
 * Write the local copy back. A 412 means someone wrote between our last pull
 * and now: merge what the relay handed back and try again, up to five times
 * (plan §9.2), then leave the space dirty for the next trigger.
 */
export async function pushSpace(id) {
  const space = getSpace(id);
  const blob = blobs.get(id);
  if (!space || !blob || !relayConfigured()) return false;
  let local = stampSeen(space, blob);
  blobs.set(id, local);
  // The relay refuses anything over 1 MiB with a 413, and a blob that big is
  // a blob that needs compacting, not retrying (plan §9.4). Refusing here
  // rather than on the wire keeps the local copy intact and lets the UI say so.
  if (blobBytes(local) > MAX_BLOB_BYTES) {
    space.dirty = true;
    setStatus(id, "too-large");
    await saveSpaces();
    emitSpaces(id, "too-large");
    return false;
  }
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const cipher = await encryptBlob(space.key, local);
      const res = await relayPut(space, space.lastVersion || 0, cipher);
      space.lastVersion = res.version ?? (space.lastVersion || 0) + 1;
      space.dirty = false;
      // The new key is now what the relay holds; the old one has no more work.
      if (space.prevKey) delete space.prevKey;
      blobs.set(id, local);
      setStatus(id, "ok");
      await cacheBlob(space, local);
      await saveSpaces();
      emitSpaces(id, "push");
      return true;
    } catch (err) {
      if (String(err?.message) === "too-large") {
        space.dirty = true;
        setStatus(id, "too-large");
        await saveSpaces();
        emitSpaces(id, "too-large");
        return false;
      }
      if (String(err?.message) === "conflict" && err.current) {
        // Between our last pull and this push, somebody wrote. Their blob is
        // under the key THEY had - which, in the seconds after a rotate, is
        // the key we have just replaced. `prevKey` keeps that one readable
        // for exactly as long as it takes the rotation to land; without it a
        // rotate on a slightly-stale copy bricks the space on this phone.
        const keys = [space.key, space.prevKey].filter(Boolean);
        let theirs;
        let read = false;
        for (const k of keys) {
          try {
            theirs = err.current.blob ? await decryptBlob(k, err.current.blob) : null;
            read = true;
            break;
          } catch { /* try the next one */ }
        }
        if (read) {
          local = mergeBlobs(local, theirs);
          blobs.set(id, local);
          space.lastVersion = err.current.version ?? space.lastVersion;
          continue;
        }
        // unreadable under every key we hold: somebody ELSE rotated
        setStatus(id, "expired");
        return false;
      }
      handleRelayError(id, err);
      space.dirty = true;
      await saveSpaces();
      return false;
    }
  }
  // Five merge-and-retry rounds lost: the space is busy, not broken. The op
  // stays in the blob (which IS the outbox — `dirty` is the flag) and the next
  // trigger tries again; app.js turns this reason into one toast (plan §9.2).
  space.dirty = true;
  await saveSpaces();
  emitSpaces(id, "push-failed");
  return false;
}

/**
 * Stamp my own `lastSeen` on every push. Owner-written like every other
 * per-member field, and the only thing "inactive" is ever read off (§9.21).
 * A rotation I have already adopted is stamped at the same time, which is what
 * makes the "still needs the new invite" list shrink by itself (§8).
 */
function stampSeen(space, blob) {
  if (!blob) return blob;
  const at = new Date().toISOString();
  let touched = false;
  const members = (blob.members || []).map((m) => {
    if (m.memberId !== space.myMemberId) return m;
    const sawRotation = blob.rotatedAt && String(m.sawRotation || "") < blob.rotatedAt
      ? blob.rotatedAt : (m.sawRotation || null);
    if (m.lastSeen === at && m.sawRotation === sawRotation) return m;
    touched = true;
    return { ...m, lastSeen: at, sawRotation, rev: (Number(m.rev) || 0) + 1 };
  });
  return touched ? { ...blob, members } : blob;
}

/** Local edit made: coalesce a push 1.5s later so a burst is one write. */
export function queuePush(id) {
  clearTimeout(pushTimers.get(id));
  pushTimers.set(id, setTimeout(() => { pushTimers.delete(id); pushSpace(id); }, PUSH_DEBOUNCE));
}

export async function pullAll({ force = false } = {}) {
  for (const s of spaces()) await pullSpace(s.id, { force });
}

/** The cheap 3-minute poll: one HEAD each, a GET only when the version moved. */
async function pollAll() {
  if (document.hidden) return;
  for (const s of spaces()) {
    const st = spaceStatus(s.id);
    if (st === "expired" || st === "gone") continue;
    try {
      const { version } = await relayHead(s);
      if (version != null && version !== s.lastVersion) await pullSpace(s.id);
      else if (s.dirty) await pushSpace(s.id);
    } catch (err) {
      handleRelayError(s.id, err);
    }
  }
}

/**
 * Called once per unlock. Restores the cached blobs so the screens work
 * offline, then pulls, and wires the triggers: visibility, the SW's
 * `spaces-changed` message, and the 3-minute poll.
 */
export async function initSpaces() {
  for (const s of spaces()) {
    const cached = await loadCachedBlob(s);
    if (cached) blobs.set(s.id, cached);
    if (s.status) status.set(s.id, s.status);
    await loadArchive(s);
  }
  await syncNotifKeys();
  notifyOn = !!(await getMeta("pushOn"));
  await syncSpaceHeads();
  if (spaces().length) emitSpaces(null, "loaded");
  markReady();

  if (!started) {
    started = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pullAll();
    });
    // Back on the network: everything that queued while offline goes out now
    // (plan §9.3). `dirty` is the outbox, so a pull-then-push per space is the
    // whole of the flush.
    window.addEventListener("online", () => {
      for (const s of spaces()) if (spaceStatus(s.id) === "offline") status.set(s.id, "ok");
      emitSpaces(null, "status");
      pullAll();
    });
    window.addEventListener("offline", () => {
      for (const s of spaces()) status.set(s.id, "offline");
      emitSpaces(null, "status");
    });
    // The worker's three messages (spaces-changed / open / push-resubscribe)
    // are wired once in app.js via installPushMessageHandlers, so there is
    // exactly one pull per push and the deep link has somewhere to land.
    clearInterval(pollTimer);
    pollTimer = setInterval(pollAll, POLL_MS);
  }
  pullAll();
  resubscribeSpacePush().catch(() => {});
}

/* ============================================================
   Mutations
   ============================================================ */

/** Create a space, push it, and hand back the bundle. */
export async function createSpace({ name, color = "violet", myName, myColor = "violet" }) {
  const keys = createSpaceKeys();
  const memberId = newMemberId();
  const space = newBundle({
    ...keys,
    name: String(name || "").trim(),
    color,
    myMemberId: memberId,
    myName: String(myName || "").trim(),
  });
  const blob = emptyBlob({
    name: space.name,
    color,
    member: { memberId, name: space.myName, color: myColor },
  });
  state.spaces = [...(state.spaces || []), space];
  blobs.set(space.id, blob);
  status.set(space.id, "ok");
  await saveSpaces();
  await syncNotifKeys();
  await cacheBlob(space, blob);
  emitSpaces(space.id, "created");
  await pushSpace(space.id);
  await subscribeSpace(space);
  await syncSpaceHeads();
  return space;
}

/**
 * Read an invite without joining: decode it, fetch the blob, decrypt it, and
 * report who is already inside. Throws Error with one of the documented codes
 * so the sheet can say the right sentence:
 *   bad-code · expired · gone · offline
 */
export async function previewInvite(code) {
  const invite = decodeInvite(code); // throws "bad-code"
  const existing = getSpace(invite.id);
  if (!relayConfigured()) throw new Error("offline");
  let res;
  try {
    res = await relayGet({ id: invite.id, token: invite.token });
  } catch (err) {
    const m = String(err?.message);
    if (m === "unauthorised") throw new Error("expired");
    if (m === "not-found") throw new Error("gone");
    throw new Error("offline");
  }
  let blob;
  try {
    blob = normaliseBlob(await decryptBlob(invite.key, res.blob));
  } catch {
    throw new Error("expired"); // right token, wrong key = a rotated space
  }
  const alreadyMember = !!existing &&
    blob.members.some((m) => m.memberId === existing.myMemberId && !m.leftAt);
  return { invite, blob, version: res.version ?? 0, existing, alreadyMember };
}

/**
 * Join from a preview. Appends me to `members`, pushes, and returns the bundle.
 * Re-joining a space I already hold (a fresh invite after a rotate, §8) keeps
 * my member id and just swaps in the new keys.
 */
export async function joinSpace(preview, { displayName, color = "violet" } = {}) {
  const { invite, blob, version, existing } = preview;
  const memberId = existing?.myMemberId || newMemberId();
  const name = String(displayName || "").trim();

  const space = existing
    ? Object.assign(existing, {
        token: invite.token, key: invite.key, notifKey: invite.notifKey,
        name: blob.name, color: blob.color, myName: name,
        lastVersion: version, dirty: true, status: "ok",
      })
    : newBundle({
        ...invite, name: blob.name, color: blob.color, myMemberId: memberId, myName: name,
      });
  if (!existing) {
    space.lastVersion = version;
    state.spaces = [...(state.spaces || []), space];
  }

  const at = new Date().toISOString();
  const mine = blob.members.find((m) => m.memberId === memberId);
  const members = mine
    ? blob.members.map((m) => (m.memberId === memberId
        ? { ...m, name, color, leftAt: null, rev: (Number(m.rev) || 0) + 1 }
        : m))
    : [...blob.members, { memberId, name, color, joinedAt: at, leftAt: null, rev: 1 }];

  const merged = mergeBlobs(blob, { ...blob, members });
  blobs.set(space.id, merged);
  status.set(space.id, "ok");
  await saveSpaces();
  await syncNotifKeys();
  await cacheBlob(space, merged);
  emitSpaces(space.id, "joined");
  await pushSpace(space.id);
  await pullSpace(space.id, { force: true });
  await subscribeSpace(space);
  await syncSpaceHeads();
  notifyChange(space, {
    t: "join", space: space.name, by: name,
    n: (blobs.get(space.id)?.members || []).filter((m) => !m.leftAt).length,
  });
  return space;
}

/**
 * Take the keys from a fresh invite for a space I am already in. This is how a
 * rotate heals (plan §8): same bundle, same member id, new token/key/notifKey,
 * then a forced pull to prove it reads again. A no-op when the keys match.
 */
export async function adoptInvite(preview) {
  const { invite, version, existing } = preview;
  const space = existing || getSpace(invite.id);
  if (!space) return null;
  if (space.token === invite.token && space.key === invite.key) return space;
  space.token = invite.token;
  space.key = invite.key;
  space.notifKey = invite.notifKey;
  space.lastVersion = version ?? space.lastVersion;
  space.dirty = false;
  space.status = "ok";
  status.set(space.id, "ok");
  await saveSpaces();
  await syncNotifKeys();
  emitSpaces(space.id, "adopted");
  await pullSpace(space.id, { force: true });
  // Push my `sawRotation`, so the inviter's "still needs the new invite" list
  // loses a name the moment I am back in (plan §8).
  await pushSpace(space.id);
  return space;
}

/** Rename / recolour a space. Bumps the blob-level rev so other phones see it. */
export async function renameSpace(id, { name, color }) {
  const space = getSpace(id);
  const blob = blobs.get(id);
  if (!space || !blob) return null;
  const next = {
    ...blob,
    name: name != null ? String(name).trim() : blob.name,
    color: color || blob.color,
    rev: (Number(blob.rev) || 0) + 1,
    updatedBy: space.myMemberId,
    updatedAt: new Date().toISOString(),
  };
  blobs.set(id, next);
  space.name = next.name;
  space.color = next.color;
  space.dirty = true;
  await saveSpaces();
  await cacheBlob(space, next);
  emitSpaces(id, "renamed");
  queuePush(id);
  return space;
}

/** Change my own display name or colour inside one space (owner-only field). */
export async function renameMe(id, { name, color }) {
  const space = getSpace(id);
  const blob = blobs.get(id);
  if (!space || !blob) return null;
  const members = blob.members.map((m) => (m.memberId === space.myMemberId
    ? { ...m, name: name != null ? String(name).trim() : m.name, color: color || m.color, rev: (Number(m.rev) || 0) + 1 }
    : m));
  const next = { ...blob, members };
  blobs.set(id, next);
  space.myName = members.find((m) => m.memberId === space.myMemberId)?.name || space.myName;
  space.dirty = true;
  await saveSpaces();
  await cacheBlob(space, next);
  emitSpaces(id, "member");
  queuePush(id);
  return space;
}

/** Per-space toggle: mirror the notification key for the SW, or don't (§7.4). */
export async function setNotifDetails(id, on) {
  const space = getSpace(id);
  if (!space) return;
  space.notifDetails = !!on;
  await saveSpaces();
  await syncNotifKeys(); // adds or removes meta notifKeys[id] — nothing else
  emitSpaces(id, "settings");
}

/**
 * Leave (plan §8): mark my `leftAt` and push it so the others see it, then drop
 * the bundle, the cached blob and the notification key from this phone. If I
 * was the last one in, the space is deleted on the relay too.
 */
export async function leaveSpace(id) {
  const space = getSpace(id);
  if (!space) return false;
  const blob = blobs.get(id);
  let last = false;

  if (blob) {
    const at = new Date().toISOString();
    const members = blob.members.map((m) => (m.memberId === space.myMemberId
      ? { ...m, leftAt: at, rev: (Number(m.rev) || 0) + 1 } : m));
    last = members.every((m) => m.leftAt);
    const next = { ...blob, members };
    blobs.set(id, next);
    await pushSpace(id);
    if (!last) {
      notifyChange(space, {
        t: "leave", space: space.name, by: space.myName,
        n: members.filter((m) => !m.leftAt).length,
      });
    }
    if (last) { try { await relayDelete(space); } catch {} }
  }
  await unsubscribeSpace(space);

  // My accepted rows are my money and they stay — but the bundle that gave
  // them their label is about to go, so the label is written onto them once
  // (plan §8: "tagged Left Home").
  const mine = (state.entries || []).filter((e) => e.spaceId === id);
  if (mine.length) {
    await writeRows({ patch: mine.map((e) => ({ id: e.id, spaceLeft: space.name })) });
  }

  state.spaces = (state.spaces || []).filter((s) => s.id !== id);
  blobs.delete(id);
  status.delete(id);
  archives.delete(id);
  clearTimeout(pushTimers.get(id));
  pushTimers.delete(id);
  try { await dbDel("meta", cacheKey(id)); } catch {}
  try { await dbDel("meta", archiveKey(id)); } catch {}
  await saveSpaces();
  await syncNotifKeys();
  await syncSpaceHeads();
  emitSpaces(id, "left");
  return true;
}

/**
 * Rotate (plan §8): brand-new token, data key and notification key. The blob is
 * re-encrypted under the new key and the relay's token hash is swapped, so
 * every old invite stops working and everyone else needs the new code.
 * Returns the new invite code.
 */
export async function rotateSpace(id) {
  const space = getSpace(id);
  if (!space) throw new Error("gone");
  // Catch up BEFORE swapping keys: a rotate that starts from a stale copy has
  // to merge a 412 written under the old key, and the less of that window
  // there is the better.
  await pullSpace(id, { force: true });
  const blob = blobs.get(id);
  if (!blob) throw new Error("gone");
  const keys = createSpaceKeys();
  await relayRotate(space, await sha256Hex(keys.token));

  const at = new Date().toISOString();
  // `rotatedAt` on the blob plus one `sawRotation` per member is the whole of
  // the bookkeeping: everyone behind the line still holds a dead invite, and
  // re-joining with the new code is what moves them past it (plan §8).
  const rotated = {
    ...blob,
    rotatedAt: at,
    members: (blob.members || []).map((m) => (m.memberId === space.myMemberId
      ? { ...m, sawRotation: at, rev: (Number(m.rev) || 0) + 1 } : m)),
  };
  blobs.set(id, rotated);

  space.prevKey = space.key;
  space.token = keys.token;
  space.key = keys.key;
  space.notifKey = keys.notifKey;
  space.dirty = true;
  status.set(id, "ok");
  await saveSpaces();
  await syncNotifKeys();
  await syncSpaceHeads();
  // Re-encrypt everything held under the old key, cache and archive alike.
  await cacheBlob(space, rotated);
  await saveArchive(space, archives.get(id) || []);
  const ok = await pushSpace(id);
  emitSpaces(id, "rotated");
  if (!ok) throw new Error("offline");
  return inviteCodeFor(space);
}

/* ============================================================
   Upkeep (plan §8): compaction, liveness, rotation bookkeeping
   ============================================================ */

/** "2026-09" for today, without pulling in util/format. */
const thisMonthStr = () => new Date().toISOString().slice(0, 7);

/** Should this space be offered compaction, and what would it fold away? */
export function compactionFor(id) {
  const blob = blobs.get(id);
  if (!blob) return { due: false, urgent: false, reason: null, bytes: 0, count: 0, month: null, saves: 0 };
  return compactionDue(blob, thisMonthStr());
}

/** A dry run of compacting to `month`, for the confirm copy. */
export function compactionPreview(id, month) {
  const blob = blobs.get(id);
  if (!blob) return null;
  return compactionPlan(blob, month || compactionFor(id).month);
}

/**
 * Fold everything before `month` into per-pair carry totals and push.
 * The removed detail is archived on THIS phone first; the other phones archive
 * their own copies when they pull (see foldArchive). Any member may do this —
 * there is no admin — and it is monotonic, so two people doing it at once
 * simply agree on the further of the two lines.
 */
export async function compactSpace(id, month = null) {
  const space = getSpace(id);
  const blob = blobs.get(id);
  if (!space || !blob) return null;
  const target = month || compactionFor(id).month;
  const { blob: next, removed, carry, month: line } = applyCompaction(blob, target);
  if (!removed.length) return { removed: 0, month: line, carry };

  await saveArchive(space, [...(archives.get(id) || []), ...removed]
    .sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1)));
  blobs.set(id, next);
  space.dirty = true;
  await cacheBlob(space, next);
  await saveSpaces();
  emitSpaces(id, "compacted");
  await pushSpace(id);
  return { removed: removed.length, month: line, carry, bytes: blobBytes(next) };
}

/** Members who have not pulled in a month — shown as "inactive" (§9.21). */
export function staleIn(id) {
  const blob = blobs.get(id);
  if (!blob) return [];
  return staleMembers(blob, new Date().toISOString());
}

/** Who is still holding a dead invite after a rotate (§8). */
export function pendingRotation(id) {
  const space = getSpace(id);
  const blob = blobs.get(id);
  if (!space || !blob || !blob.rotatedAt) return [];
  return needsNewInvite(blob, space.myMemberId);
}

/** When this space was last rotated, or null. */
export const rotatedAtOf = (id) => blobs.get(id)?.rotatedAt || null;

/**
 * A personal-sync pull replaced `state.spaces` wholesale (plan §9.7): the
 * in-memory blobs may belong to bundles that no longer exist, and the bundles
 * that arrived have caches this process has never read. Start again.
 */
export async function reloadSpacesAfterSync() {
  const live = new Set(spaces().map((s) => s.id));
  for (const id of [...blobs.keys()]) if (!live.has(id)) blobs.delete(id);
  for (const id of [...archives.keys()]) if (!live.has(id)) archives.delete(id);
  for (const s of spaces()) {
    if (!blobs.has(s.id)) {
      const cached = await loadCachedBlob(s);
      if (cached) blobs.set(s.id, cached);
    }
    archives.delete(s.id);
    await loadArchive(s);
  }
  await syncNotifKeys();
  await syncSpaceHeads();
  emitSpaces(null, "resynced");
  await pullAll({ force: true });
}

/** Drop a space this phone can no longer read (expired / closed remotely). */
export async function forgetSpace(id) {
  const space = getSpace(id);
  const mine = (state.entries || []).filter((e) => e.spaceId === id);
  if (space && mine.length) {
    await writeRows({ patch: mine.map((e) => ({ id: e.id, spaceLeft: space.name })) });
  }
  state.spaces = (state.spaces || []).filter((s) => s.id !== id);
  blobs.delete(id);
  status.delete(id);
  archives.delete(id);
  try { await dbDel("meta", cacheKey(id)); } catch {}
  try { await dbDel("meta", archiveKey(id)); } catch {}
  await saveSpaces();
  await syncNotifKeys();
  await syncSpaceHeads();
  emitSpaces(id, "forgotten");
}

/* ============================================================
   Shared entries (plan §5.1 – §5.3)
   ============================================================

   Two halves again, and only one of them ever leaves the phone:

     • the SharedEntry in the blob — title, amount, split, who paid, and one
       owner-written status per participant. No account ids, ever.
     • MY ledger rows — at most one `expense` for my share and one `lent` for
       what I fronted. They are derived from the entry by syncMyRows() and
       rewritten in one silent save, so the surface that triggered the change
       repaints itself and the page underneath stays exactly where it was.

   Every mutation here follows the same five beats: build the next entry, swap
   it into the blob, re-derive my rows, cache + save, queue the push. */

/* ------------------------------------------------------------
   Push fan-out (plan 7.2)
   ------------------------------------------------------------ */

/** One notification per space per 5 s: a burst of edits is one banner. */
const NOTIFY_COALESCE = 5000;
/** spaceId -> the summary that will be sent when its timer fires. */
const notifyPending = new Map();
const notifyTimers = new Map();

async function sendSummary(space, summary) {
  try {
    if (!space || !space.notifKey) return;
    const payload = await sealSummary(space.notifKey, summary);
    await relayNotify(space, payload, deviceId());
  } catch (err) {
    // A notification is the nicety on top of the pull-on-open path: if the
    // relay is unreachable, or nobody is subscribed, nothing is lost.
    console.debug("space notify failed", err);
  }
}

/**
 * Tell the other members that something happened. Fire-and-forget by design:
 * it never throws, never blocks the mutation that called it, and does nothing
 * at all when there is no relay or notifications are off on this phone.
 *
 * Coalesced per space within 5 s - the LATEST summary wins, because that is
 * the one that describes where the entry actually ended up.
 */
export function notifyChange(space, summary) {
  if (!space || !summary) return null;
  // SENDING is not gated on this phone's own "Notify me" toggle. That toggle
  // says whether I want to be told about other people's writes; it has no
  // business deciding whether they get told about mine. All that is needed is
  // a relay to post to and a notification key to seal with — receiving stays
  // gated by `pushOn`, through the subscription the relay fans out to.
  if (!relayUrl() || !space.notifKey) return null;
  let encoded;
  try { encoded = encodeSummary(summary); } catch { return null; }

  notifyPending.set(space.id, { space, summary: encoded });
  if (notifyTimers.has(space.id)) return null;
  notifyTimers.set(space.id, setTimeout(() => {
    notifyTimers.delete(space.id);
    const queued = notifyPending.get(space.id);
    notifyPending.delete(space.id);
    if (queued) sendSummary(queued.space, queued.summary);
  }, NOTIFY_COALESCE));
  return null;
}

/* ------------------------------------------------------------
   Subscriptions (plan 7.1) - one device, every space
   ------------------------------------------------------------ */

const SPACES_SYNC_TAG = "batwa-spaces";
const SYNC_MIN_INTERVAL = 12 * 60 * 60 * 1000;

/** meta `pushOn`: does this phone want notifications for shared spaces? */
let notifyOn = false;

/** True once the user turned the master toggle on, whatever the transport. */
export const spacePushOn = () => notifyOn;

async function swReg() {
  try { return await navigator.serviceWorker.ready; } catch { return null; }
}

function periodicSyncSupported() {
  try { return "periodicSync" in ServiceWorkerRegistration.prototype; } catch { return false; }
}

/**
 * "on" | "off" | "unavailable" | "not-installed" | "denied" - the same five
 * states the Reminders row uses. `pushState()` answers for the browser; the
 * stored flag decides between on and off once the browser has said yes.
 */
export async function spacePushState() {
  if (!relayUrl()) return "unavailable";
  const st = await pushState();
  // An uninstalled browser has no push, but periodic sync may still be there
  // (plan 7.3) - the row stays actionable rather than going dead.
  if (st === "not-installed" && periodicSyncSupported()) return notifyOn ? "on" : "off";
  if (st === "on" || st === "off") return notifyOn ? "on" : "off";
  return st;
}

/**
 * The space ids + tokens the service worker's periodic-sync fallback needs.
 * Written ONLY while notifications are on - the same device-grade trust as
 * `notifKeys`, and the Settings copy says so out loud (plan 7.3).
 */
async function syncSpaceHeads() {
  if (!notifyOn) {
    try { await dbDel("meta", "spaceHeads"); } catch {}
    try { await dbDel("meta", "spaceVersions"); } catch {}
    return;
  }
  await setMeta("spaceHeads", spaces().map((s) => ({ id: s.id, token: s.token })));
}

async function registerSpacesSync() {
  if (!periodicSyncSupported()) return false;
  const reg = await swReg();
  if (!reg || !reg.periodicSync) return false;
  try {
    await reg.periodicSync.register(SPACES_SYNC_TAG, { minInterval: SYNC_MIN_INTERVAL });
    return true;
  } catch { return false; }
}

async function unregisterSpacesSync() {
  const reg = await swReg();
  try { reg && reg.periodicSync && (await reg.periodicSync.unregister(SPACES_SYNC_TAG)); } catch {}
}

/** Register this device's current subscription against one space. */
async function subscribeSpace(space, subscription = null) {
  if (!notifyOn || !relayUrl() || !space) return false;
  try {
    const sub = subscription || (await currentSubscription());
    if (!sub) return false;
    await relaySubscribe(space, deviceId(), space.myMemberId, sub);
    return true;
  } catch (err) {
    console.debug("space subscribe failed", err);
    return false;
  }
}

/** Drop this device from one space's fan-out list. */
async function unsubscribeSpace(space) {
  if (!relayUrl() || !space) return false;
  try {
    await relayUnsubscribe(space, deviceId());
    return true;
  } catch (err) {
    console.debug("space unsubscribe failed", err);
    return false;
  }
}

/**
 * Turn notifications on for every space at once (the Settings master toggle).
 * Push is the real transport; where it cannot be had but periodic sync can -
 * an installed Android that refused a subscription - the 12h HEAD fallback
 * takes over and only ever shows the generic banner.
 */
export async function enableSpacePush() {
  if (!relayUrl()) return { ok: false, reason: "Shared spaces need a relay URL in js/config.js." };

  let res = { ok: false, reason: "This browser can't receive notifications." };
  if (pushSupported()) res = await subscribePush(VAPID_PUBLIC_KEY);

  if (!res.ok) {
    const fallback = await registerSpacesSync();
    if (!fallback) return res;
    notifyOn = true;
    await setMeta("pushOn", true);
    await syncSpaceHeads();
    emitSpaces(null, "notifications");
    return { ok: true, mode: "periodic" };
  }

  notifyOn = true;
  await setMeta("pushOn", true);
  await setMeta("pushEndpoint", res.subscription.endpoint || null);
  await setMeta("pushResubscribe", false);
  let failed = 0;
  for (const s of spaces()) {
    if (!(await subscribeSpace(s, res.subscription))) failed++;
  }
  await syncSpaceHeads();
  await registerSpacesSync(); // a no-op where periodic sync does not exist
  emitSpaces(null, "notifications");
  return { ok: true, mode: "push", failed };
}

/** The inverse: off the relay, off the browser, and no tokens left behind. */
export async function disableSpacePush() {
  for (const s of spaces()) await unsubscribeSpace(s);
  try { await unsubscribePush(); } catch {}
  notifyOn = false;
  await setMeta("pushOn", false);
  await unregisterSpacesSync();
  await syncSpaceHeads(); // notifyOn is false now, so this deletes them
  for (const key of ["pushEndpoint", "pushResubscribe"]) {
    try { await dbDel("meta", key); } catch {}
  }
  emitSpaces(null, "notifications");
  return { ok: true };
}

/**
 * After unlock: quietly put the subscription back if the browser rotated it
 * (meta `pushResubscribe`, set by the worker) or if it vanished while we still
 * think notifications are on. Never prompts - a device that has not granted
 * permission is left alone until the user asks again.
 */
export async function resubscribeSpacePush() {
  if (!relayUrl()) return false;
  const flagged = !!(await getMeta("pushResubscribe"));
  if (!notifyOn) {
    if (flagged) await setMeta("pushResubscribe", false);
    return false;
  }
  if (!pushSupported()) return false;
  let perm = "default";
  try { perm = Notification.permission; } catch {}
  if (perm !== "granted") return false;
  if (!flagged && (await currentSubscription())) return false;

  const res = await subscribePush(VAPID_PUBLIC_KEY);
  if (!res.ok) return false;
  for (const s of spaces()) await subscribeSpace(s, res.subscription);
  await setMeta("pushEndpoint", res.subscription.endpoint || null);
  await setMeta("pushResubscribe", false);
  await syncSpaceHeads();
  return true;
}

/** Put `entry` into the blob (replacing any older copy) and cache it. */
async function writeEntry(space, entry, reason = "entry") {
  const blob = blobs.get(space.id);
  if (!blob) return null;
  const entries = blob.entries.some((e) => e.id === entry.id)
    ? blob.entries.map((e) => (e.id === entry.id ? entry : e))
    : [...blob.entries, entry];
  const next = { ...blob, entries };
  blobs.set(space.id, next);
  space.dirty = true;
  await cacheBlob(space, next);
  await saveSpaces();
  emitSpaces(space.id, reason);
  queuePush(space.id);
  return next;
}

/** The entry as it stands right now, or null. */
export function sharedEntry(spaceId, entryId) {
  return (blobs.get(spaceId)?.entries || []).find((e) => e.id === entryId) || null;
}

/** My share of a shared entry, in whole rupees. */
export const myShareOf = (entry, space) =>
  Math.round(Number(entry?.split?.shares?.[space?.myMemberId]) || 0);

/**
 * Make my personal ledger agree with one shared entry. Accepted means rows
 * exist; anything else means they do not. `opts` carries the choices that are
 * mine alone and never go in the blob: the account, the category I filed it
 * under, my own note.
 */
async function syncMyRows(space, entry, opts = {}) {
  const me = space.myMemberId;
  // A settlement has no share and no split: its rows are written by
  // settleWithPerson / acceptSettlement, which know which side of it I am on.
  if (entry.kind === "settlement") return rowsForShared(space.id, entry.id);
  if (entry.participants?.[me]?.status !== "accepted") {
    return setSharedRows(space.id, entry.id, []);
  }
  const prev = rowsForShared(space.id, entry.id);
  const prevExp = prev.find((e) => e.kind === "expense") || null;
  const prevLent = prev.find((e) => e.kind === "lent") || null;

  const total = Math.round(Number(entry.amount) || 0);
  const myShare = myShareOf(entry, space);
  const iPaid = entry.paidBy === me;
  const accountId = opts.accountId !== undefined
    ? opts.accountId
    : (prevExp?.accountId ?? prevLent?.accountId ?? null);
  const category = opts.category || prevExp?.category || entry.category || "Others";
  const note = opts.note !== undefined ? opts.note : (prevExp?.note ?? entry.note ?? "");
  // Both rows are dated by the SPEND, not by the moment I pressed accept: noon
  // local on the entry's own date, so an evening accept cannot file what I
  // fronted under yesterday while my share sits under today.
  const day = String(entry.date || "").slice(0, 10);
  const now = day
    ? new Date(`${day}T12:00:00`).toISOString()
    : new Date().toISOString();
  const common = {
    title: entry.title || "Shared",
    recurrence: "one-time",
    sharedTotal: total,
    sharedRev: Number(entry.rev) || 1,
  };

  const rows = [];
  if (myShare > 0) {
    rows.push({
      ...common,
      kind: "expense",
      amount: myShare,
      category,
      note,
      dueDate: String(entry.date || "").slice(0, 10) || null,
      // I fronted it: the money is gone. Someone else did: it is a debt to
      // them, committed but not deducted until it is settled (M4).
      status: iPaid ? "paid" : "pending",
      paidAt: iPaid ? (prevExp?.paidAt || now) : null,
      accountId,
      owedTo: iPaid ? null : entry.paidBy,
    });
  }
  if (iPaid && total - myShare > 0) {
    rows.push({
      ...common,
      kind: "lent",
      amount: total - myShare,
      repaid: Number(prevLent?.repaid) || 0,
      category,
      note: "",
      dueDate: null,
      status: "paid",
      paidAt: prevLent?.paidAt || now,
      accountId,
      owedTo: null,
    });
  }
  return setSharedRows(space.id, entry.id, rows);
}

const nowIso = () => new Date().toISOString();

/**
 * Per-space defaults (plan §8). Remembered on every accept, propose and
 * settle, and only ever OVERWRITTEN by a real choice: "No account" is a
 * decision about one entry, not an instruction to forget the account I have
 * used for this space nine times running.
 */
function rememberDefaults(space, { accountId, category } = {}) {
  if (!space) return;
  if (accountId) space.lastAccountId = accountId;
  if (category) space.lastCategory = category;
}

/** A fresh participant map: me accepted, everyone else asked. */
function freshParticipants(memberIds, me, at) {
  const out = {};
  for (const m of memberIds) {
    out[m] = m === me
      ? { status: "accepted", rev: 1, at, reason: null }
      : { status: "proposed", rev: 1, at, reason: null };
  }
  return out;
}

/**
 * Propose a shared expense (or income). `shares` must already sum to `amount`
 * — the form builds it with splitEqually() or from the custom inputs, so the
 * rounding rule lives in exactly one place.
 */
export async function proposeShared(spaceId, {
  kind = "expense", title, amount, category = "Others", note = "", date,
  paidBy, shares, mode = "equal", accountId = null,
}) {
  const space = getSpace(spaceId);
  const blob = blobs.get(spaceId);
  if (!space || !blob) return null;
  const me = space.myMemberId;
  const at = nowIso();
  const entry = {
    id: uuid(),
    kind,
    title: String(title || "").trim(),
    amount: Math.round(Number(amount) || 0),
    currency: "PKR",
    category,
    note: "",                       // the shared note stays empty in v1
    date: String(date || at).slice(0, 10),
    proposedBy: me,
    createdAt: at,
    rev: 1,
    updatedBy: me,
    updatedAt: at,
    split: { mode, shares: { ...shares } },
    paidBy,
    participants: freshParticipants(Object.keys(shares), me, at),
    settlement: null,
    conflicts: [],
  };
  rememberDefaults(space, { accountId, category });
  await syncMyRows(space, entry, { accountId, category, note });
  await writeEntry(space, entry, "proposed");
  notifyChange(space, {
    t: "split", space: space.name, by: space.myName,
    title: entry.title, amount: entry.amount, n: Object.keys(shares).length,
  });
  return entry;
}

/** Say yes, and write my rows. The account and category are local only. */
export async function acceptShared(spaceId, entryId, { accountId = null, category = null, note = "" } = {}) {
  const space = getSpace(spaceId);
  const cur = sharedEntry(spaceId, entryId);
  if (!space || !cur) return null;
  const me = space.myMemberId;
  const at = nowIso();
  const mine = cur.participants?.[me] || {};
  const entry = {
    ...cur,
    participants: {
      ...cur.participants,
      [me]: { status: "accepted", rev: (Number(mine.rev) || 0) + 1, at, reason: null },
    },
  };
  rememberDefaults(space, { accountId, category });
  await syncMyRows(space, entry, { accountId, category, note });
  await writeEntry(space, entry, "accepted");
  notifyChange(space, {
    t: "accept", space: space.name, by: space.myName,
    title: entry.title, amount: myShareOf(entry, space),
  });
  return entry;
}

/** Say no, with a reason. Any rows I had written for it go away again. */
export async function rejectShared(spaceId, entryId, reason = null) {
  const space = getSpace(spaceId);
  const cur = sharedEntry(spaceId, entryId);
  if (!space || !cur) return null;
  const me = space.myMemberId;
  const at = nowIso();
  const mine = cur.participants?.[me] || {};
  const entry = {
    ...cur,
    participants: {
      ...cur.participants,
      [me]: { status: "rejected", rev: (Number(mine.rev) || 0) + 1, at, reason: reason || null },
    },
  };
  await syncMyRows(space, entry);
  await writeEntry(space, entry, "rejected");
  notifyChange(space, {
    t: "reject", space: space.name, by: space.myName, title: entry.title, reason,
  });
  return entry;
}

/**
 * Change the money on a shared entry. `rev` goes up, which makes this the
 * current version for everyone, and every OTHER participant drops back to
 * `proposed` — their already-written rows are left alone until they answer the
 * "Faraz changed Dinner from Rs 3,000 to Rs 3,300" card (plan §9.9).
 * My own status stays accepted unless `acceptMine` says otherwise.
 *
 * `resetOthers: false` is for an edit that cannot change what anyone else
 * owes — covering a rejected share myself — where resetting them would ask
 * three people to re-approve a number that did not move.
 */
export async function editShared(spaceId, entryId, {
  amount, shares, mode, title, category, date, paidBy,
  resetOthers = true, acceptMine = true, accountId, note,
} = {}) {
  const space = getSpace(spaceId);
  const cur = sharedEntry(spaceId, entryId);
  if (!space || !cur) return null;
  const me = space.myMemberId;
  const at = nowIso();
  const nextShares = shares ? { ...shares } : { ...(cur.split?.shares || {}) };

  const participants = {};
  for (const [m, p] of Object.entries(cur.participants || {})) {
    // Somebody dropped out of the split keeps the status they already gave —
    // their key is never deleted, because merge unions participant keys and a
    // deletion would simply be revived by the next phone that still has it.
    // Their share is gone from `split.shares`, which is what the money reads.
    if (!(m in nextShares)) { participants[m] = p; continue; }
    if (m === me) {
      participants[m] = acceptMine
        ? { status: "accepted", rev: (Number(p.rev) || 0) + 1, at, reason: null }
        : p;
    } else if (resetOthers) {
      participants[m] = { status: "proposed", rev: (Number(p.rev) || 0) + 1, at, reason: null };
    } else {
      participants[m] = p;
    }
  }
  for (const m of Object.keys(nextShares)) {
    if (!participants[m]) participants[m] = { status: "proposed", rev: 1, at, reason: null };
  }

  const entry = {
    ...cur,
    title: title != null ? String(title).trim() : cur.title,
    amount: amount != null ? Math.round(Number(amount) || 0) : cur.amount,
    category: category || cur.category,
    date: date ? String(date).slice(0, 10) : cur.date,
    paidBy: paidBy || cur.paidBy,
    split: { mode: mode || cur.split?.mode || "custom", shares: nextShares },
    participants,
    rev: (Number(cur.rev) || 0) + 1,
    updatedBy: me,
    updatedAt: at,
  };
  rememberDefaults(space, { accountId, category });
  await syncMyRows(space, entry, { accountId, category, note });
  await writeEntry(space, entry, "edited");
  notifyChange(space, {
    t: "edit", space: space.name, by: space.myName, title: entry.title, amount: entry.amount,
  });
  return entry;
}

/**
 * Withdraw a proposal of mine (plan §9.8, §9.13). A tombstone at the entry's
 * own revision, so an edit somebody made offline at the SAME revision loses to
 * it, and an edit they made at a higher one survives — which is exactly the
 * rule merge.js already enforces for everyone else.
 *
 * Only the proposer may do this. Everybody else rejects their own share, which
 * keeps the entry (and the disagreement) visible instead of erasing it.
 */
export async function removeShared(spaceId, entryId) {
  const space = getSpace(spaceId);
  const blob = blobs.get(spaceId);
  const cur = sharedEntry(spaceId, entryId);
  if (!space || !blob || !cur) return false;
  if (cur.proposedBy !== space.myMemberId) return false;

  const at = nowIso();
  const tombstones = [
    ...(blob.tombstones || []).filter((t) => t.id !== entryId),
    { id: entryId, rev: Number(cur.rev) || 1, by: space.myMemberId, at },
  ];
  const next = mergeBlobs(
    { ...blob, tombstones },
    { ...blob, tombstones },
  );
  blobs.set(spaceId, next);
  await setSharedRows(spaceId, entryId, []);
  space.dirty = true;
  await cacheBlob(space, next);
  await saveSpaces();
  emitSpaces(spaceId, "withdrawn");
  queuePush(spaceId);
  notifyChange(space, {
    t: "edit", space: space.name, by: space.myName,
    title: cur.title || "an entry", amount: 0,
  });
  return true;
}

/**
 * Deal with what a rejection left behind (plan §9.10).
 *   "split" — share it equally among everyone still in, total unchanged.
 *             Their numbers move, so they all have to look again.
 *   "cover" — the payer absorbs it. Nobody else's number moves, so nobody
 *             else is asked again.
 */
export async function resolveUnassigned(spaceId, entryId, how) {
  const space = getSpace(spaceId);
  const cur = sharedEntry(spaceId, entryId);
  if (!space || !cur) return null;
  const rejected = Object.entries(cur.participants || {})
    .filter(([, p]) => p.status === "rejected").map(([m]) => m);
  if (!rejected.length) return cur;
  const rest = Object.keys(cur.split?.shares || {}).filter((m) => !rejected.includes(m));
  if (!rest.length) return cur;

  if (how === "split") {
    const shares = splitEqually(cur.amount, rest, cur.paidBy);
    return editShared(spaceId, entryId, { shares, mode: "equal", resetOthers: true });
  }
  const shares = {};
  for (const m of rest) shares[m] = Math.round(Number(cur.split?.shares?.[m]) || 0);
  const payer = rest.includes(cur.paidBy) ? cur.paidBy : rest[0];
  shares[payer] += unassignedOf(cur);
  return editShared(spaceId, entryId, { shares, mode: "custom", resetOthers: false });
}

/* ============================================================
   Settlements (plan §6, §9.10, §9.11, §9.13, §9.18)
   ============================================================

   Money between two people, and the one place in the app where a shared entry
   is aimed at a single person instead of a whole space. The shape is the same
   as any other SharedEntry — one `settlement` kind, one participant who has to
   answer — so merge, the pending inbox and the space screen need no new rules.

   The asymmetry is deliberate and comes straight from the plan (§0): the
   sender's money is gone the moment they press Save, the receiver's arrives
   only when they say it did, into the account they say it landed in. Between
   those two moments the settlement is "pending" on both phones, and if the
   receiver says "Didn't receive" it becomes "unconfirmed" on the sender's —
   never silently reversed, because only the two humans know what happened.

   What Save actually does to MY ledger:
     • covered pending shares become paid (or part-paid) FROM the From account.
       That is the deduction — a settlement row on top would take the money
       twice.
     • whatever is left over beyond the covered items is a `settlement` out row
       of its own, because it is real money leaving with nothing to attach to.
   And on their accept: a `settlement` in row, plus `repaid` on the `lent` rows
   the covers name, so what I fronted stops being outstanding.                */

/** "pending" | "confirmed" | "unconfirmed" for a settlement SharedEntry. */
export function settlementStatus(spaceId, entryId) {
  const entry = sharedEntry(spaceId, entryId);
  if (!entry || entry.kind !== "settlement") return null;
  const other = entry.settlement?.to;
  const st = entry.participants?.[other]?.status;
  return st === "accepted" ? "confirmed" : st === "rejected" ? "unconfirmed" : "pending";
}

/**
 * The same three words for a LEDGER row: a settlement row of my own, or a
 * share that a settlement of mine paid off. A write-off answers to nobody.
 */
export function rowSettlementStatus(row) {
  if (!row || isWriteoff(row)) return null;
  // A settlement row IS the settlement; any other row points at the one that
  // paid it off, whose own `sharedEntryId` belongs to the expense instead.
  const id = row.kind === "settlement" ? row.sharedEntryId : row.settledBy;
  if (!row.spaceId || !id) return null;
  return settlementStatus(row.spaceId, id);
}

/** The settlement SharedEntry id behind a ledger row, for Nudge again. */
export const settlementIdOf = (row) =>
  (row?.kind === "settlement" ? row.sharedEntryId : row?.settledBy) || null;

/**
 * What I still owe one person in one space: my pending shares that name them
 * as the payer, oldest first — which is also the order a short payment is
 * allocated in, so the list on screen and the arithmetic agree by construction.
 */
export function coversFor(spaceId, memberId) {
  return (state.entries || [])
    .filter((e) => e.kind === "expense" && e.status === "pending" &&
      e.spaceId === spaceId && e.owedTo === memberId && stillOwedOf(e) > 0)
    .map((e) => ({
      rowId: e.id,
      sharedEntryId: e.sharedEntryId,
      title: e.title || "Shared",
      date: String(e.dueDate || e.createdAt || "").slice(0, 10),
      amount: Math.round(Number(e.amount) || 0),
      paid: Math.round(partialOf(e)),
      remaining: Math.round(stillOwedOf(e)),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Oldest-first allocation of `amount` across the chosen covers (§9.11). */
export function allocateCovers(list, amount) {
  let left = Math.max(0, Math.round(Number(amount) || 0));
  const covers = [];
  for (const c of list) {
    if (left <= 0) break;
    const take = Math.min(c.remaining, left);
    if (take <= 0) continue;
    covers.push({ ...c, take });
    left -= take;
  }
  return { covers, remainder: left };
}

/**
 * Every person I could send money to, for the transfer sheet's People group.
 * A contact link (§8) folds one human who is in three spaces into one entry
 * with three spaces to choose between; anyone unlinked appears once per space,
 * with the space's name under their own, because from here they are two
 * different debts that happen to share a name.
 */
export function peopleForTransfer() {
  const out = [];
  const claimed = new Set();
  const liveMember = (spaceId, memberId) =>
    (blobs.get(spaceId)?.members || []).find((m) => m.memberId === memberId && !m.leftAt) || null;

  for (const [cid, c] of Object.entries(state.contacts || {})) {
    const links = [];
    for (const l of c?.links || []) {
      const space = getSpace(l.spaceId);
      const m = space && liveMember(l.spaceId, l.memberId);
      if (!space || !m || m.memberId === space.myMemberId) continue;
      links.push({ spaceId: space.id, memberId: m.memberId, spaceName: space.name, color: m.color });
      claimed.add(`${space.id}:${m.memberId}`);
    }
    if (links.length) {
      out.push({
        key: `c:${cid}`,
        name: c.name || memberNameIn(links[0].spaceId, links[0].memberId),
        color: links[0].color, linked: true, spaces: links,
      });
    }
  }

  for (const s of spaces()) {
    for (const m of blobs.get(s.id)?.members || []) {
      if (m.leftAt || m.memberId === s.myMemberId) continue;
      if (claimed.has(`${s.id}:${m.memberId}`)) continue;
      out.push({
        key: `m:${s.id}:${m.memberId}`, name: m.name, color: m.color, linked: false,
        spaces: [{ spaceId: s.id, memberId: m.memberId, spaceName: s.name, color: m.color }],
      });
    }
  }
  return out;
}

/**
 * Send money to a member. `coverIds` are the SharedEntry ids ticked in the
 * Covers list; the allocation is done here so the "Rs 400 of Rs 1,000 paid"
 * on screen and the rupees written to the ledger can never disagree.
 */
export async function settleWithPerson(spaceId, {
  memberId, amount, fromAccountId = null, note = "", coverIds = [],
} = {}) {
  const space = getSpace(spaceId);
  const blob = blobs.get(spaceId);
  if (!space || !blob) return null;
  const me = space.myMemberId;
  const total = Math.round(Number(amount) || 0);
  if (!memberId || total <= 0) return null;

  const chosen = coversFor(spaceId, memberId).filter((c) => coverIds.includes(c.sharedEntryId));
  const { covers, remainder } = allocateCovers(chosen, total);

  const at = nowIso();
  const day = at.slice(0, 10);
  const entry = {
    id: uuid(),
    kind: "settlement",
    title: `Settled with ${memberNameIn(spaceId, memberId)}`,
    amount: total,
    currency: "PKR",
    category: null,
    note: "",
    date: day,
    proposedBy: me,
    createdAt: at,
    rev: 1,
    updatedBy: me,
    updatedAt: at,
    split: { mode: "custom", shares: {} },
    paidBy: me,
    participants: {
      [me]: { status: "accepted", rev: 1, at, reason: null },
      [memberId]: { status: "proposed", rev: 1, at, reason: null },
    },
    settlement: {
      from: me, to: memberId,
      covers: covers.map((c) => ({ id: c.sharedEntryId, amount: c.take })),
    },
    conflicts: [],
  };

  // My ledger, in one save: the shares this clears, and the leftover if any.
  const patch = covers.map((c) => {
    const done = c.take >= c.remaining;
    return {
      id: c.rowId,
      status: done ? "paid" : "pending",
      paidAt: done ? at : null,
      paidPartial: done ? 0 : c.paid + c.take,
      accountId: fromAccountId,
      settledBy: entry.id,
    };
  });
  const add = [];
  if (remainder > 0) {
    add.push({
      kind: "settlement",
      direction: "out",
      title: `Sent to ${memberNameIn(spaceId, memberId)}`,
      amount: remainder,
      category: null,
      recurrence: "one-time",
      dueDate: null,
      status: "paid",
      paidAt: at,
      accountId: fromAccountId,
      note: String(note || "").trim(),
      spaceId,
      sharedEntryId: entry.id,
      counterpart: memberId,
    });
  }
  await writeRows({ patch, add });

  rememberDefaults(space, { accountId: fromAccountId });
  await writeEntry(space, entry, "settled");
  notifyChange(space, {
    t: "settle", space: space.name, by: space.myName,
    title: entry.title, amount: total, n: covers.length,
  });
  return entry;
}

/**
 * "Got it": the money landed, in this account. The sender's `lent` rows stop
 * being outstanding for exactly what the covers named, and this side of the
 * space balance closes.
 */
export async function acceptSettlement(spaceId, entryId, { accountId = null } = {}) {
  const space = getSpace(spaceId);
  const cur = sharedEntry(spaceId, entryId);
  if (!space || !cur || cur.kind !== "settlement") return null;
  const me = space.myMemberId;
  const at = nowIso();
  const mine = cur.participants?.[me] || {};
  const entry = {
    ...cur,
    participants: {
      ...cur.participants,
      [me]: { status: "accepted", rev: (Number(mine.rev) || 0) + 1, at, reason: null },
    },
  };

  const from = cur.settlement?.from;
  await setSharedRows(spaceId, entryId, [{
    kind: "settlement",
    direction: "in",
    title: `From ${memberNameIn(spaceId, from)}`,
    amount: Math.round(Number(cur.amount) || 0),
    category: null,
    recurrence: "one-time",
    dueDate: null,
    status: "paid",
    paidAt: at,
    accountId,
    counterpart: from,
  }]);

  // Each cover repays the lent row that fronted it, never past what is out.
  const patch = [];
  for (const c of cur.settlement?.covers || []) {
    const lent = rowsForShared(spaceId, c.id).find((r) => r.kind === "lent");
    if (!lent) continue;
    const back = Math.min(Number(lent.amount) || 0, (Number(lent.repaid) || 0) + (Number(c.amount) || 0));
    patch.push({ id: lent.id, repaid: back });
  }
  if (patch.length) await writeRows({ patch });

  rememberDefaults(space, { accountId });
  await writeEntry(space, entry, "settle-accepted");
  notifyChange(space, {
    t: "accept", space: space.name, by: space.myName, title: entry.title, amount: entry.amount,
  });
  return entry;
}

/** "Didn't receive": their rows stay, mine do not, and the sender is told. */
export async function rejectSettlement(spaceId, entryId, reason = "Didn't receive") {
  const space = getSpace(spaceId);
  const cur = sharedEntry(spaceId, entryId);
  if (!space || !cur || cur.kind !== "settlement") return null;
  const me = space.myMemberId;
  const at = nowIso();
  const mine = cur.participants?.[me] || {};
  const entry = {
    ...cur,
    participants: {
      ...cur.participants,
      [me]: { status: "rejected", rev: (Number(mine.rev) || 0) + 1, at, reason },
    },
  };
  await setSharedRows(spaceId, entryId, []);
  await writeEntry(space, entry, "settle-rejected");
  notifyChange(space, {
    t: "reject", space: space.name, by: space.myName, title: entry.title, reason,
  });
  return entry;
}

/**
 * Give up on what a member who left still owes me (§9.18). My ledger only —
 * the space is not told, because this is a decision about my money, and they
 * are not here to argue with it. The receivable stops being outstanding and
 * the same rupees leave through `writtenOff`, so nothing reappears in `total`.
 *
 * `lent` rows are per-entry, not per-person, so the repayment lands on my
 * oldest outstanding rows in this space. That is the order a real repayment
 * would have cleared them in.
 */
export async function writeOffMember(spaceId, memberId) {
  const space = getSpace(spaceId);
  if (!space) return null;
  const owed = Math.round(netFor(spaceId).perMember?.[memberId] || 0);
  if (owed <= 0) return null;

  let left = owed;
  const patch = [];
  const lentRows = (state.entries || [])
    .filter((e) => e.kind === "lent" && e.spaceId === spaceId && outstandingOf(e) > 0)
    .sort((a, b) => (String(a.paidAt || a.createdAt) < String(b.paidAt || b.createdAt) ? -1 : 1));
  for (const row of lentRows) {
    if (left <= 0) break;
    const take = Math.min(outstandingOf(row), left);
    patch.push({ id: row.id, repaid: (Number(row.repaid) || 0) + take });
    left -= take;
  }

  const at = nowIso();
  await writeRows({
    patch,
    add: [{
      kind: "settlement",
      direction: "in",
      writeoff: true,
      title: `Written off · ${memberNameIn(spaceId, memberId)}`,
      amount: owed,
      category: null,
      recurrence: "one-time",
      dueDate: null,
      status: "paid",
      paidAt: at,
      accountId: null,
      spaceId,
      counterpart: memberId,
    }],
  });
  emitSpaces(spaceId, "writeoff");
  return owed;
}

/** M5 sends the reminder for real; for now it is the same stub as the rest. */
export function nudgeSettlement(spaceId, entryId) {
  const space = getSpace(spaceId);
  const entry = sharedEntry(spaceId, entryId);
  if (!space || !entry) return null;
  return notifyChange(space, {
    t: "nudge", space: space.name, by: space.myName,
    title: entry.title, amount: Number(entry.amount) || 0,
  });
}
