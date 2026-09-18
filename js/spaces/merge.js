// Merging two versions of a space blob. Pure, synchronous, no imports — the
// Node fixture runs this file untouched.
//
// Three writers with no server-side logic means last-writer-wins on the whole
// document loses data, so every piece of the blob carries its own revision:
//
//   • blob name/colour   one `rev` for the space's own fields
//   • entry shared fields one `rev` per entry, bumped by whoever edits
//   • participants[m]    one `rev` per member, and only member m ever writes it
//   • members[m]         same owner-only rule
//   • tombstones         monotonic: a delete at rev >= the entry's rev wins
//
// The result must not depend on which side is `a`: `merge(a, b)` and
// `merge(b, a)` are deep-equal, and `merge(x, x)` is `x` normalised. Every
// tie-break below is therefore total and symmetric — never "prefer local".
//
// Merge is commutative and idempotent, but NOT associative in one corner: an
// entry whose `rev` has climbed above a tombstone survives the delete, so a
// pairwise merge that drops it and a later merge that revives it can lose the
// participant statuses the dropped side carried. That never happens in the
// real topology, because nobody merges two peers directly — every phone merges
// its own copy against the relay's current blob and pushes the result, which
// makes the relay a monotonic accumulator. The fixture covers exactly that.

export const BLOB_VERSION = 1;

/** A brand-new blob with one member: me. */
export function emptyBlob({ name, color, member, at = new Date().toISOString() }) {
  return {
    v: BLOB_VERSION,
    name,
    color,
    rev: 1,
    updatedBy: member.memberId,
    updatedAt: at,
    createdAt: at,
    members: [{ ...member, joinedAt: member.joinedAt || at, leftAt: null, rev: 1 }],
    entries: [],
    tombstones: [],
    compactedBefore: null,
    carry: {},
    rotatedAt: null,
  };
}

/* ============================================================
   Months and pair keys — the two bits of vocabulary compaction needs
   ============================================================ */

/** "2026-03-14T…" -> "2026-03". Anything unparseable -> "". */
export const monthOf = (iso) => String(iso || "").slice(0, 7);

/** The first day of a month, which is what an entry date is compared against. */
export const monthStart = (ym) => `${String(ym || "").slice(0, 7)}-01`;

/** Month arithmetic without a Date: "2026-01" shifted by -6 is "2025-07". */
export function shiftMonthStr(ym, delta) {
  const [y, m] = String(ym || "").split("-").map(Number);
  if (!y || !m) return ym;
  const total = y * 12 + (m - 1) + Number(delta || 0);
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}`;
}

/**
 * Carry is stored pairwise, not per person, because a vector of net positions
 * cannot be un-summed back into "who owes whom" once three people are in the
 * room. One key per unordered pair, always `lower|higher`, and the value is
 * what the HIGHER id owes the LOWER one. That makes the map canonical: two
 * phones that compact the same entries produce byte-identical carry.
 */
export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** `a` is owed `v` more by `b`. Negative `v` flips it. Zeroes are pruned. */
export function pairAdd(carry, a, b, v) {
  if (!a || !b || a === b) return carry;
  const amount = Math.round(Number(v) || 0);
  if (!amount) return carry;
  const key = pairKey(a, b);
  const signed = a < b ? amount : -amount;
  const next = (Number(carry[key]) || 0) + signed;
  if (next) carry[key] = next; else delete carry[key];
  return carry;
}

/** Sum two carry maps into a fresh one, with deterministic key order. */
export function mergeCarry(a = {}, b = {}) {
  const out = {};
  for (const src of [a || {}, b || {}]) {
    for (const [k, v] of Object.entries(src)) {
      const n = (Number(out[k]) || 0) + (Number(v) || 0);
      if (n) out[k] = n; else delete out[k];
    }
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/** The canonical, sorted form of one carry map. */
const normCarry = (c) => mergeCarry(c, {});

/* ============================================================
   Tie-breaks
   ============================================================ */

/** A stable, order-independent ordering of two values of the same shape. */
function jsonKey(v) {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x);
}

/** Later ISO timestamp wins; a tie falls back to the greater serialisation. */
function laterOf(a, b, stamp) {
  const ta = String(a?.[stamp] ?? "");
  const tb = String(b?.[stamp] ?? "");
  if (ta !== tb) return ta > tb ? a : b;
  const ka = jsonKey(a);
  const kb = jsonKey(b);
  if (ka === kb) return a;
  return ka > kb ? a : b;
}

/** Higher `rev` wins; equal revs fall to `laterOf`. */
function byRev(a, b, stamp) {
  if (!a) return b;
  if (!b) return a;
  const ra = Number(a.rev) || 0;
  const rb = Number(b.rev) || 0;
  if (ra !== rb) return ra > rb ? a : b;
  return laterOf(a, b, stamp);
}

const minIso = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
const maxIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/* ============================================================
   Pieces
   ============================================================ */

function mergeMembers(a = [], b = []) {
  const by = new Map();
  for (const m of [...a, ...b]) {
    if (!m || !m.memberId) continue;
    by.set(m.memberId, byRev(by.get(m.memberId), m, "joinedAt"));
  }
  return [...by.values()].sort((x, y) => (x.memberId < y.memberId ? -1 : x.memberId > y.memberId ? 1 : 0));
}

function mergeTombstones(a = [], b = []) {
  const by = new Map();
  for (const t of [...a, ...b]) {
    if (!t || !t.id) continue;
    by.set(t.id, byRev(by.get(t.id), t, "at"));
  }
  return [...by.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function mergeParticipants(a = {}, b = {}) {
  const out = {};
  for (const id of new Set([...Object.keys(a || {}), ...Object.keys(b || {})]).values()) {
    out[id] = byRev(a?.[id], b?.[id], "at");
  }
  // deterministic key order, so two merges serialise identically
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/** The fields an edit bumps `rev` for. Everything else is owner-scoped. */
const SHARED_FIELDS = [
  "kind", "title", "amount", "currency", "category", "note", "date",
  "split", "paidBy", "settlement", "proposedBy", "createdAt",
];

function sharedShape(e) {
  const out = {};
  for (const f of SHARED_FIELDS) out[f] = e?.[f] ?? null;
  return out;
}

const sameShared = (a, b) => jsonKey(sharedShape(a)) === jsonKey(sharedShape(b));

function conflictOf(e) {
  return {
    rev: Number(e.rev) || 0,
    updatedBy: e.updatedBy ?? null,
    updatedAt: e.updatedAt ?? null,
    fields: sharedShape(e),
  };
}

function mergeConflicts(lists) {
  const by = new Map();
  for (const list of lists) {
    for (const c of list || []) {
      if (!c) continue;
      by.set(jsonKey(c), c);
    }
  }
  return [...by.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([, c]) => c);
}

/**
 * One entry, present on both sides. The higher `rev` is the current version;
 * an equal rev with different content keeps the later `updatedAt` as current
 * and files the other under `conflicts` for the user to resolve.
 */
function mergeEntry(a, b) {
  let winner;
  let loser = null;
  const ra = Number(a.rev) || 0;
  const rb = Number(b.rev) || 0;
  if (ra !== rb) {
    winner = ra > rb ? a : b;
  } else if (sameShared(a, b)) {
    winner = laterOf(a, b, "updatedAt");
  } else {
    winner = laterOf(a, b, "updatedAt");
    loser = winner === a ? b : a;
  }

  const merged = { ...winner };
  merged.participants = mergeParticipants(a.participants, b.participants);
  merged.conflicts = mergeConflicts([
    a.conflicts, b.conflicts, loser ? [conflictOf(loser)] : [],
  ]);
  // A conflict the current version has itself resolved is no longer a conflict.
  merged.conflicts = merged.conflicts.filter((c) => jsonKey(c.fields) !== jsonKey(sharedShape(merged)));
  return merged;
}

/* ============================================================
   The whole blob
   ============================================================ */

/**
 * Merge two decrypted space blobs. Either may be null (a first pull, or a
 * space that only exists locally). Pure: neither input is mutated.
 */
export function mergeBlobs(a, b) {
  if (!a && !b) return null;
  if (!a) return normaliseBlob(b);
  if (!b) return normaliseBlob(a);

  const head = byRev(
    { rev: Number(a.rev) || 0, updatedAt: a.updatedAt ?? null, updatedBy: a.updatedBy ?? null, name: a.name, color: a.color },
    { rev: Number(b.rev) || 0, updatedAt: b.updatedAt ?? null, updatedBy: b.updatedBy ?? null, name: b.name, color: b.color },
    "updatedAt"
  );

  const tombstones = mergeTombstones(a.tombstones, b.tombstones);
  const tombRev = new Map(tombstones.map((t) => [t.id, Number(t.rev) || 0]));

  const byId = new Map();
  for (const e of a.entries || []) if (e && e.id) byId.set(e.id, [e, null]);
  for (const e of b.entries || []) {
    if (!e || !e.id) continue;
    const pair = byId.get(e.id);
    if (pair) pair[1] = e;
    else byId.set(e.id, [null, e]);
  }

  // `compactedBefore` and `carry` travel as ONE unit and are monotonic: the
  // side that has compacted further already folded everything the other side
  // is still carrying in full, so taking its carry alone is exactly right.
  // Taking the max of both maps instead would double-count every old rupee.
  const compaction = compactionHead(a, b);

  const entries = [];
  for (const [id, [ea, eb]] of byId) {
    const merged = ea && eb ? mergeEntry(ea, eb) : normaliseEntry(ea || eb);
    // A delete at a revision the editor had already seen beats the edit.
    if (tombRev.has(id) && tombRev.get(id) >= (Number(merged.rev) || 0)) continue;
    // Compacted away: the detail is gone from the blob and lives on as carry
    // (and, on each phone, in its own `spaceArchive:<id>`).
    if (isCompacted(merged, compaction.compactedBefore)) continue;
    entries.push(merged);
  }
  entries.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  return {
    v: BLOB_VERSION,
    name: head.name,
    color: head.color,
    rev: head.rev,
    updatedBy: head.updatedBy,
    updatedAt: head.updatedAt,
    createdAt: minIso(a.createdAt, b.createdAt),
    members: mergeMembers(a.members, b.members),
    entries,
    tombstones,
    compactedBefore: compaction.compactedBefore,
    carry: compaction.carry,
    rotatedAt: maxIso(a.rotatedAt, b.rotatedAt) ?? null,
  };
}

/** Is this entry behind the compaction line? */
export function isCompacted(entry, compactedBefore) {
  if (!compactedBefore) return false;
  const day = String(entry?.date || "").slice(0, 10);
  if (!day) return false;
  return day < monthStart(compactedBefore);
}

/**
 * The winning `{ compactedBefore, carry }` of two blobs. Max month wins; an
 * equal month means both sides compacted the same range, so their carries
 * ought to agree — the greater serialisation is taken to stay deterministic.
 */
function compactionHead(a, b) {
  const ca = String(a?.compactedBefore || "");
  const cb = String(b?.compactedBefore || "");
  if (ca === cb) {
    const ka = jsonKey(normCarry(a?.carry));
    const kb = jsonKey(normCarry(b?.carry));
    return {
      compactedBefore: ca || null,
      carry: ka >= kb ? normCarry(a?.carry) : normCarry(b?.carry),
    };
  }
  const win = ca > cb ? a : b;
  return { compactedBefore: String(win.compactedBefore || "") || null, carry: normCarry(win?.carry) };
}

function normaliseEntry(e) {
  return {
    ...e,
    participants: mergeParticipants(e.participants, {}),
    conflicts: mergeConflicts([e.conflicts]),
  };
}

/**
 * The canonical form of a blob: the same field order and the same sort order a
 * merge would produce, so `merge(x, x)` can be compared with `x` directly.
 */
export function normaliseBlob(blob) {
  if (!blob) return null;
  const tombstones = mergeTombstones(blob.tombstones, []);
  const tombRev = new Map(tombstones.map((t) => [t.id, Number(t.rev) || 0]));
  const compactedBefore = blob.compactedBefore || null;
  const entries = (blob.entries || [])
    .filter((e) => e && e.id)
    .map(normaliseEntry)
    .filter((e) => !(tombRev.has(e.id) && tombRev.get(e.id) >= (Number(e.rev) || 0)))
    .filter((e) => !isCompacted(e, compactedBefore))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {
    v: BLOB_VERSION,
    name: blob.name,
    color: blob.color,
    rev: Number(blob.rev) || 0,
    updatedBy: blob.updatedBy ?? null,
    updatedAt: blob.updatedAt ?? null,
    createdAt: blob.createdAt ?? null,
    members: mergeMembers(blob.members, []),
    entries,
    tombstones,
    compactedBefore,
    carry: normCarry(blob.carry),
    rotatedAt: blob.rotatedAt ?? null,
  };
}

/* ============================================================
   Display names — unique within a space (plan §9.16)
   ============================================================ */

const norm = (s) => String(s || "").trim().toLowerCase();

/** Is this display name already worn by somebody still in the space? */
export function nameTaken(blob, name, exceptMemberId = null) {
  return (blob?.members || []).some(
    (m) => m.memberId !== exceptMemberId && !m.leftAt && norm(m.name) === norm(name)
  );
}

/**
 * The first free variant of `base`: "Zubair", then "Zubair (2)", "Zubair (3)".
 * An already-numbered name keeps its stem rather than growing "(2) (2)".
 */
export function suggestName(blob, base, exceptMemberId = null) {
  const clean = String(base || "").trim() || "Me";
  if (!nameTaken(blob, clean, exceptMemberId)) return clean;
  const stem = clean.replace(/\s*\(\d+\)$/, "").trim() || "Me";
  for (let n = 2; n < 100; n++) {
    const candidate = `${stem} (${n})`;
    if (!nameTaken(blob, candidate, exceptMemberId)) return candidate;
  }
  return `${stem} (${Date.now() % 1000})`;
}

/** "Zubair bin Shaukat" -> "ZS"; one word -> its first two letters. */
export function initialsOf(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/* ============================================================
   Money helpers that belong with the data, not with a screen
   ============================================================ */

/**
 * Split `total` whole rupees between `memberIds`. Everyone gets the floor; the
 * remainder goes to `paidBy` (or the first member when the payer is not in the
 * split). 1000 across three, paid by A -> A 334, the others 333.
 */
export function splitEqually(total, memberIds, paidBy) {
  const ids = [...new Set(memberIds.filter(Boolean))];
  const shares = {};
  if (!ids.length) return shares;
  const amount = Math.max(0, Math.round(Number(total) || 0));
  const base = Math.floor(amount / ids.length);
  let remainder = amount - base * ids.length;
  const first = ids.includes(paidBy) ? paidBy : ids[0];
  for (const id of ids) shares[id] = base;
  shares[first] += remainder;
  return shares;
}

/**
 * My net position in a space: positive when the others owe me, negative when I
 * owe. Only accepted-or-proposed entries that are not tombstoned count, and a
 * settlement moves the balance the other way.
 *
 * `writeoffs` (M4, plan §9.18) is `{ memberId: rupees }` of debt I have given
 * up on. It lives in MY ledger only — a write-off is my decision about my own
 * money and the space never hears about it — so it cannot be read off the blob
 * and has to be handed in. Without it the hero would keep insisting a member
 * who left still owes me money I have already written off.
 *
 * A settlement counts for its sender the moment it is sent (plan §0: "the
 * sender's balance drops immediately") and for its receiver unless they have
 * said "Didn't receive". The two phones therefore disagree while a settlement
 * is disputed, which is exactly what the dispute is.
 */
export function netPosition(blob, myMemberId, { writeoffs = null } = {}) {
  let net = 0;
  const perMember = {};
  const bump = (id, v) => { perMember[id] = (perMember[id] || 0) + v; };
  for (const e of blob?.entries || []) {
    const shares = e?.split?.shares || {};
    if (e.kind === "settlement") {
      const { from, to } = e.settlement || {};
      const amount = Math.round(Number(e.amount) || 0);
      if (from === myMemberId) { net += amount; bump(to, amount); }
      else if (to === myMemberId && e.participants?.[myMemberId]?.status !== "rejected") {
        net -= amount; bump(from, -amount);
      }
      continue;
    }
    const sign = e.kind === "income" ? -1 : 1;
    if (e.paidBy === myMemberId) {
      for (const [id, share] of Object.entries(shares)) {
        if (id === myMemberId) continue;
        net += sign * Math.round(Number(share) || 0);
        bump(id, sign * Math.round(Number(share) || 0));
      }
    } else if (shares[myMemberId] != null) {
      const share = Math.round(Number(shares[myMemberId]) || 0);
      net -= sign * share;
      bump(e.paidBy, -sign * share);
    }
  }
  // Everything compacted away, still counted to the rupee (plan §8).
  for (const [key, v] of Object.entries(blob?.carry || {})) {
    const amount = Math.round(Number(v) || 0);
    if (!amount) continue;
    const [lo, hi] = String(key).split("|");
    if (lo === myMemberId) { net += amount; bump(hi, amount); }
    else if (hi === myMemberId) { net -= amount; bump(lo, -amount); }
  }
  for (const [id, v] of Object.entries(writeoffs || {})) {
    const amount = Math.round(Number(v) || 0);
    if (!amount) continue;
    net -= amount;
    bump(id, -amount);
  }
  return { net, perMember };
}

/* ============================================================
   Compaction (plan §8) — pure, so both phones can agree on the arithmetic
   ============================================================

   A space that has run for a year is mostly history: entries everybody has
   already accepted and already paid for. Compaction replaces that history with
   one number per pair of people, which is the only thing the history still
   means to the money. The detail is not destroyed — every phone keeps its own
   encrypted `spaceArchive:<id>` before it pushes — but it stops being pushed
   to, pulled from and merged by three phones forever.

   The invariant this file guarantees, and the fixture asserts:
       netPosition(before, m) === netPosition(after, m)   for every member m
   which holds by construction, because `carryOf` is exactly the pairwise form
   of what `netPosition` would have read off the entries being removed.        */

/** The hard ceiling the relay enforces (413). Nothing may be pushed past it. */
export const MAX_BLOB_BYTES = 1024 * 1024;
/** Where compaction starts being offered (plan §8). */
export const COMPACT_BYTES = 512 * 1024;
/** How much history is kept, in months, when age is what triggers it. */
export const COMPACT_KEEP_MONTHS = 6;

/** Rough wire size of a blob. The ciphertext is a shade bigger; close enough. */
export function blobBytes(blob) {
  try { return JSON.stringify(blob || {}).length; } catch { return 0; }
}

/**
 * Can this entry be folded away? Only when nobody is still being asked
 * anything about it: every named participant has said yes, and no two phones
 * are arguing over its fields. A "proposed" or "rejected" share means the
 * entry is still live money and it stays, however old it is.
 */
export function compactable(entry) {
  if (!entry) return false;
  if ((entry.conflicts || []).length) return false;
  const people = Object.values(entry.participants || {});
  if (!people.length) return false;
  return people.every((p) => p?.status === "accepted");
}

/** The pairwise carry one entry contributes. Mirrors netPosition exactly. */
export function carryOf(entry, into = {}) {
  const shares = entry?.split?.shares || {};
  if (entry?.kind === "settlement") {
    const { from, to } = entry.settlement || {};
    // Only a settlement the receiver confirmed can be folded; an unconfirmed
    // one is never `compactable` in the first place, so this is belt and braces.
    if (from && to && entry.participants?.[to]?.status !== "rejected") {
      pairAdd(into, from, to, Math.round(Number(entry.amount) || 0));
    }
    return into;
  }
  const sign = entry?.kind === "income" ? -1 : 1;
  const payer = entry?.paidBy;
  if (!payer) return into;
  for (const [id, share] of Object.entries(shares)) {
    if (id === payer) continue;
    pairAdd(into, payer, id, sign * Math.round(Number(share) || 0));
  }
  return into;
}

/**
 * What compacting to the start of `month` would do, without doing it.
 * `{ month, removed, kept, carry, before, after }` — `removed` is the detail
 * each phone archives locally, `carry` the pairwise residue that replaces it.
 */
export function compactionPlan(blob, month) {
  const cutoff = monthStart(month);
  const removed = [];
  const kept = [];
  for (const e of blob?.entries || []) {
    const day = String(e.date || "").slice(0, 10);
    if (day && day < cutoff && compactable(e)) removed.push(e);
    else kept.push(e);
  }
  const carry = {};
  for (const e of removed) carryOf(e, carry);
  return {
    month: String(month || "").slice(0, 7),
    removed,
    kept,
    carry: normCarry(carry),
    before: blobBytes(blob),
    after: blobBytes({ ...blob, entries: kept, carry: mergeCarry(blob?.carry, carry) }),
  };
}

/** Apply a plan. Returns the next blob; the caller archives `plan.removed`. */
export function applyCompaction(blob, month) {
  const plan = compactionPlan(blob, month);
  // An entry too old to keep but not yet settled pins the line back to its own
  // month: compactedBefore must never step over something still live, because
  // merge drops everything behind the line on sight.
  const oldestKept = plan.kept
    .map((e) => String(e.date || "").slice(0, 7))
    .filter(Boolean)
    .sort()[0];
  const line = oldestKept && oldestKept < plan.month ? oldestKept : plan.month;
  const removed = plan.removed.filter((e) => String(e.date).slice(0, 10) < monthStart(line));
  const carry = {};
  for (const e of removed) carryOf(e, carry);
  const goneIds = new Set(removed.map((e) => e.id));
  const next = {
    ...blob,
    entries: (blob.entries || []).filter((e) => !goneIds.has(e.id)),
    carry: mergeCarry(blob?.carry, carry),
    compactedBefore: maxIso(blob?.compactedBefore || null, line) || line,
  };
  return { blob: normaliseBlob(next), removed, carry: normCarry(carry), month: line };
}

/**
 * Should the user be offered compaction right now? Size first, then age:
 * six clear months of entries nobody is waiting on any more (plan §8).
 * `thisMonth` is passed in so the fixture does not depend on the calendar.
 */
export function compactionDue(blob, thisMonth) {
  const bytes = blobBytes(blob);
  const line = shiftMonthStr(thisMonth, -COMPACT_KEEP_MONTHS);
  const plan = compactionPlan(blob, line);
  const oldEnough = plan.removed.length > 0;
  const tooBig = bytes >= COMPACT_BYTES;
  return {
    due: tooBig || oldEnough,
    urgent: bytes >= MAX_BLOB_BYTES,
    reason: tooBig ? "size" : oldEnough ? "age" : null,
    bytes,
    month: line,
    count: plan.removed.length,
    saves: Math.max(0, plan.before - plan.after),
  };
}

/* ============================================================
   Liveness (plan §9.21)
   ============================================================ */

/** Thirty days without a pull and a member stops being counted on. */
export const STALE_DAYS = 30;

/**
 * Members who have not touched the space in `days`. Each phone stamps its own
 * `lastSeen` on every push, so this is owner-written data like every other
 * per-member field — nobody can mark anybody else inactive.
 */
export function staleMembers(blob, nowIso, days = STALE_DAYS) {
  const cut = new Date(new Date(nowIso).getTime() - days * 86400000).toISOString();
  return (blob?.members || []).filter((m) => {
    if (m.leftAt) return false;
    const seen = m.lastSeen || m.joinedAt || null;
    return !!seen && seen < cut;
  });
}

/* ============================================================
   Rotation bookkeeping (plan §8)
   ============================================================ */

/**
 * Who still holds a dead invite. A rotation stamps `rotatedAt` on the blob;
 * every phone that re-joins with the new code stamps its own `sawRotation`.
 * The difference is the list the settings sheet shows, and it shrinks by
 * itself as people come back.
 */
export function needsNewInvite(blob, exceptMemberId = null) {
  const at = blob?.rotatedAt || null;
  if (!at) return [];
  return (blob?.members || []).filter((m) =>
    !m.leftAt && m.memberId !== exceptMemberId && String(m.sawRotation || "") < at);
}
