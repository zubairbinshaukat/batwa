// Fixtures for the owe rules in js/spaces/merge.js — run with:
//   node --test test/spaces-merge.test.mjs
//
// Members are named so the pair keys sort the way you would read them:
// "a" < "b" < "c". "a" is always "me" unless a test says otherwise.

import test from "node:test";
import assert from "node:assert/strict";
import {
  netPosition,
  foldPairs,
  applyCompaction,
  compactionPlan,
  splitEqually,
} from "../js/spaces/merge.js";

const A = "a", B = "b", C = "c";
let seq = 0;

/** A shared expense (or income) with explicit participant statuses. */
function shared({
  date, paidBy, shares, status = {}, kind = "expense", createdAt = null, id = null,
}) {
  seq++;
  const participants = {};
  for (const m of Object.keys(shares)) {
    participants[m] = { status: status[m] || "accepted", rev: 1, at: "x", reason: null };
  }
  return {
    id: id || `e${String(seq).padStart(4, "0")}`,
    kind,
    title: "t",
    amount: Object.values(shares).reduce((t, v) => t + v, 0),
    date,
    createdAt: createdAt || `${date}T10:00:${String(seq % 60).padStart(2, "0")}Z`,
    rev: 1,
    split: { mode: "custom", shares },
    paidBy,
    participants,
  };
}

/** Money sent from one member to another. `to` answers; `from` is accepted. */
function settle({ date, from, to, amount, status = "proposed", createdAt = null, id = null }) {
  seq++;
  return {
    id: id || `s${String(seq).padStart(4, "0")}`,
    kind: "settlement",
    title: "Settled",
    amount,
    date,
    createdAt: createdAt || `${date}T11:00:${String(seq % 60).padStart(2, "0")}Z`,
    rev: 1,
    split: { mode: "custom", shares: {} },
    paidBy: from,
    participants: {
      [from]: { status: "accepted", rev: 1, at: "x", reason: null },
      [to]: { status, rev: 1, at: "x", reason: null },
    },
    settlement: { from, to, covers: [] },
  };
}

const blobOf = (entries, carry = {}) => ({ entries, carry, compactedBefore: null });
const owes = (blob, me, other) => netPosition(blob, me).perMember[other] || 0;

/* ------------------------------------------------------------
   Shares
   ------------------------------------------------------------ */

test("1 · accepted share is owed", () => {
  const blob = blobOf([shared({ date: "2026-01-01", paidBy: A, shares: splitEqually(1000, [A, B], A) })]);
  assert.equal(owes(blob, A, B), 500);
  assert.equal(owes(blob, B, A), -500);
});

test("2 · proposed share is waiting, not owed", () => {
  const blob = blobOf([shared({
    date: "2026-01-01", paidBy: A, shares: { a: 500, b: 500 }, status: { b: "proposed" },
  })]);
  const mine = netPosition(blob, A);
  assert.equal(mine.perMember.b || 0, 0);
  assert.equal(mine.net, 0);
  assert.equal(mine.waiting.b, 500);
  assert.equal(mine.waitingNet, 500);
});

test("3 · rejected share counts for nothing", () => {
  const blob = blobOf([shared({
    date: "2026-01-01", paidBy: A, shares: { a: 500, b: 500 }, status: { b: "rejected" },
  })]);
  const mine = netPosition(blob, A);
  assert.equal(mine.net, 0);
  assert.equal(mine.waitingNet, 0);
});

test("3b · a payer who has not confirmed paying makes the debt wait", () => {
  // I proposed "Ali paid"; Ali has not said yes yet.
  const blob = blobOf([shared({
    date: "2026-01-01", paidBy: B, shares: { a: 500, b: 500 }, status: { b: "proposed" },
  })]);
  const mine = netPosition(blob, A);
  assert.equal(mine.perMember.b || 0, 0);
  assert.equal(mine.waiting.b, -500);
});

/* ------------------------------------------------------------
   Settlements are transfers that can only pay a debt down
   ------------------------------------------------------------ */

test("4 · sending money when nobody owes anything is a plain transfer", () => {
  const s = settle({ date: "2026-01-03", from: A, to: B, amount: 2000 });
  const blob = blobOf([s]);
  const mine = netPosition(blob, A);
  assert.equal(mine.net, 0);
  assert.deepEqual(mine.settlementSplit[s.id], { applied: 0, extra: 2000, rejected: false });
});

test("5 · sending money to someone who owes me changes nothing", () => {
  const blob = blobOf([
    shared({ date: "2026-01-01", paidBy: A, shares: { a: 500, b: 500 } }),
    settle({ date: "2026-01-03", from: A, to: B, amount: 2000 }),
  ]);
  assert.equal(owes(blob, A, B), 500);
});

test("6 · overpaying settles to zero, the rest is a transfer", () => {
  const s = settle({ date: "2026-01-03", from: A, to: B, amount: 800 });
  const blob = blobOf([shared({ date: "2026-01-01", paidBy: B, shares: { a: 500, b: 500 } }), s]);
  assert.equal(owes(blob, A, B), 0);
  assert.deepEqual(netPosition(blob, A).settlementSplit[s.id], { applied: 500, extra: 300, rejected: false });
});

test("7 · paying part of a debt leaves the rest", () => {
  const blob = blobOf([
    shared({ date: "2026-01-01", paidBy: B, shares: { a: 500, b: 500 } }),
    settle({ date: "2026-01-03", from: A, to: B, amount: 200 }),
  ]);
  assert.equal(owes(blob, A, B), -300);
});

test("the worked example: 500 → 500 → 200 → 0", () => {
  const e1 = shared({ date: "2026-01-01", paidBy: A, shares: splitEqually(1000, [A, B], A) });
  const s1 = settle({ date: "2026-01-03", from: A, to: B, amount: 2000 });
  const e2 = shared({ date: "2026-01-05", paidBy: B, shares: splitEqually(600, [A, B], B) });
  const s2 = settle({ date: "2026-01-08", from: B, to: A, amount: 200 });
  assert.equal(owes(blobOf([e1]), A, B), 500);
  assert.equal(owes(blobOf([e1, s1]), A, B), 500);
  assert.equal(owes(blobOf([e1, s1, e2]), A, B), 200);
  assert.equal(owes(blobOf([e1, s1, e2, s2]), A, B), 0);
  // …and Ali's phone reads the mirror image at every step.
  assert.equal(owes(blobOf([e1, s1, e2]), B, A), -200);
  assert.equal(netPosition(blobOf([e1, s1, e2, s2]), B).net, 0);
});

test("8 · a rejected settlement counts on neither phone", () => {
  const blob = blobOf([
    shared({ date: "2026-01-01", paidBy: B, shares: { a: 500, b: 500 } }),
    settle({ date: "2026-01-03", from: A, to: B, amount: 500, status: "rejected" }),
  ]);
  assert.equal(owes(blob, A, B), -500);
  assert.equal(owes(blob, B, A), 500);
});

test("9 · a settlement still waiting for 'Got it' counts on both phones", () => {
  const blob = blobOf([
    shared({ date: "2026-01-01", paidBy: B, shares: { a: 500, b: 500 } }),
    settle({ date: "2026-01-03", from: A, to: B, amount: 500, status: "proposed" }),
  ]);
  assert.equal(owes(blob, A, B), 0);
  assert.equal(owes(blob, B, A), 0);
});

test("10 · a backdated expense is paid by a later settlement", () => {
  // Settlement made on the 5th, the dinner it paid for entered on the 10th but
  // dated the 1st: date order puts the dinner first.
  const s = settle({ date: "2026-01-05", from: A, to: B, amount: 500, createdAt: "2026-01-05T09:00:00Z" });
  const e = shared({ date: "2026-01-01", paidBy: B, shares: { a: 500, b: 500 }, createdAt: "2026-01-10T09:00:00Z" });
  assert.equal(owes(blobOf([s, e]), A, B), 0);
});

test("11 · shared income flips the sign", () => {
  // I received 1000 on behalf of both of us: I owe Ali his half.
  const blob = blobOf([shared({ date: "2026-01-01", kind: "income", paidBy: A, shares: { a: 500, b: 500 } })]);
  assert.equal(owes(blob, A, B), -500);
});

test("12 · a write-off applies after the fold", () => {
  const blob = blobOf([shared({ date: "2026-01-01", paidBy: A, shares: { a: 500, b: 500 } })]);
  const mine = netPosition(blob, A, { writeoffs: { b: 500 } });
  assert.equal(mine.perMember.b || 0, 0);
  assert.equal(mine.net, 0);
});

test("13 · three members: B overpaying A leaves C untouched", () => {
  const blob = blobOf([
    shared({ date: "2026-01-01", paidBy: A, shares: { a: 300, b: 300, c: 300 } }),
    settle({ date: "2026-01-02", from: B, to: A, amount: 1000 }),
  ]);
  const mine = netPosition(blob, A);
  assert.equal(mine.perMember.b || 0, 0);
  assert.equal(mine.perMember.c, 300);
  assert.equal(mine.net, 300);
});

/* ------------------------------------------------------------
   Properties over random spaces
   ------------------------------------------------------------ */

/** Small deterministic PRNG so a failure reproduces. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const STATUSES = ["accepted", "accepted", "accepted", "proposed", "rejected"];

function randomBlob(r) {
  const n = 2 + Math.floor(r() * 3);
  const members = ["a", "b", "c", "d"].slice(0, n);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const entries = [];
  const count = 5 + Math.floor(r() * 25);
  for (let i = 0; i < count; i++) {
    const month = 1 + Math.floor(r() * 9);
    const day = 1 + Math.floor(r() * 28);
    const date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (r() < 0.35) {
      const from = pick(members);
      const to = pick(members.filter((m) => m !== from));
      entries.push(settle({
        date, from, to, amount: 50 + Math.floor(r() * 2000), status: pick(STATUSES),
      }));
    } else {
      const inSplit = members.filter(() => r() < 0.8);
      if (inSplit.length < 2) continue;
      const paidBy = pick(members);
      const status = {};
      for (const m of inSplit) status[m] = m === paidBy && r() < 0.7 ? "accepted" : pick(STATUSES);
      entries.push(shared({
        date, paidBy, kind: r() < 0.1 ? "income" : "expense",
        shares: splitEqually(100 + Math.floor(r() * 5000), inSplit, paidBy), status,
      }));
    }
  }
  return { members, blob: blobOf(entries) };
}

test("14 · every pair reads as a mirror image on the two phones", () => {
  const r = rng(42);
  for (let i = 0; i < 200; i++) {
    const { members, blob } = randomBlob(r);
    for (const x of members) {
      for (const y of members) {
        if (x === y) continue;
        assert.equal(owes(blob, x, y) + owes(blob, y, x), 0, `blob #${i}: ${x}/${y}`);
      }
    }
  }
});

test("14b · a settlement never pushes a pair past zero", () => {
  const r = rng(7);
  for (let i = 0; i < 200; i++) {
    const { blob } = randomBlob(r);
    const { settlementSplit } = foldPairs(blob.entries);
    for (const e of blob.entries.filter((x) => x.kind === "settlement")) {
      const s = settlementSplit[e.id];
      assert.ok(s, "every settlement gets a split");
      if (s.rejected) continue;
      assert.equal(s.applied + s.extra, e.amount);
      assert.ok(s.applied >= 0 && s.extra >= 0);
    }
  }
});

test("15 · compaction never changes anybody's balance", () => {
  const r = rng(2026);
  // Make everything compactable half the time so there is something to fold.
  for (let i = 0; i < 200; i++) {
    const { members, blob } = randomBlob(r);
    if (i % 2 === 0) {
      for (const e of blob.entries) {
        for (const p of Object.values(e.participants)) p.status = "accepted";
      }
    }
    for (const month of ["2026-03", "2026-06", "2026-09"]) {
      const { blob: after } = applyCompaction(blob, month);
      for (const m of members) {
        assert.deepEqual(
          netPosition(after, m).perMember,
          netPosition(blob, m).perMember,
          `blob #${i}, compacted to ${month}, member ${m}`,
        );
      }
    }
  }
});

test("compaction plan reports the carry it would write", () => {
  const blob = blobOf([
    shared({ date: "2026-01-01", paidBy: A, shares: { a: 500, b: 500 } }),
    settle({ date: "2026-01-02", from: B, to: A, amount: 200, status: "accepted" }),
    shared({ date: "2026-05-01", paidBy: A, shares: { a: 100, b: 100 } }),
  ]);
  const plan = compactionPlan(blob, "2026-03");
  assert.equal(plan.removed.length, 2);
  assert.deepEqual(plan.carry, { "a|b": 300 });
});
