// The ledger: entries CRUD, balance math, recurrence engine.
// Entries live in memory while unlocked; every change re-encrypts to IndexedDB.

import { dbGet, dbPut, getMeta, setMeta } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";
import { getKey } from "./auth.js";
import { uuid } from "./util/dom.js";
import { isoDate, parseDay, daysUntil } from "./util/format.js";

export const DEFAULT_CATEGORIES = [
  "Fees", "Rent/Hostel", "Food", "Transport", "Education",
  "Bills", "Health", "Shopping", "Savings", "Others",
];

export const state = {
  entries: [],
  accounts: [],   // { id, name, kind } — kind picks the logo
  categories: [...DEFAULT_CATEGORIES],
};

// ---- change notifications (app.js re-renders + schedules sync) ----
const listeners = new Set();
export const onChange = (cb) => listeners.add(cb);
function emit() {
  for (const cb of listeners) { try { cb(); } catch (e) { console.error(e); } }
}

// ---- persistence ----
export async function saveLedger() {
  const key = getKey();
  if (!key) return;
  const cipher = await encrypt(key, { entries: state.entries, accounts: state.accounts });
  await dbPut("entries", "blob", cipher);
  await setMeta("updatedAt", new Date().toISOString());
}

export async function loadLedger() {
  const key = getKey();
  const blob = await dbGet("entries", "blob");
  if (blob && key) {
    const data = await decrypt(key, blob); // throws only if key is wrong — can't be here
    state.entries = data.entries || [];
    state.accounts = data.accounts || [];
  } else {
    state.entries = [];
    state.accounts = [];
  }
  state.categories = (await getMeta("categories")) || [...DEFAULT_CATEGORIES];
  const created = await materializeRecurring();
  if (created) await saveLedger();
}

export async function saveCategories(cats) {
  const list = [...new Set(cats.map((c) => c.trim()).filter(Boolean))];
  if (!list.includes("Others")) list.push("Others"); // Others always exists
  state.categories = list;
  await setMeta("categories", list);
  emit();
}

// ---- CRUD ----
function blank() {
  return {
    id: uuid(),
    kind: "expense",
    title: "",
    amount: 0,
    category: "Others",
    recurrence: "one-time",
    dueDate: null,
    status: "pending",
    note: "",
    createdAt: new Date().toISOString(),
    paidAt: null,
    seriesId: null,
    accountId: null,
    isAdjustment: false,
  };
}

export async function addEntry(data) {
  const e = { ...blank(), ...data };
  if (e.kind === "income") {
    if (!e.status) e.status = "paid";
    e.paidAt = e.status === "paid" ? (e.paidAt || e.createdAt) : null;
  }
  if (e.kind === "expense" && e.recurrence !== "one-time" && !e.seriesId) e.seriesId = e.id;
  if (e.kind !== "transfer" && !state.categories.includes(e.category)) e.category = "Others";
  state.entries.push(e);
  await saveLedger();
  emit();
  return e;
}

/** Move money between two of the user's own accounts — one entry, both balances update live. */
export async function transferMoney({ fromAccountId, toAccountId, amount, note = "", paidAt = null }) {
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) return null;
  if (!(amount > 0)) return null;
  return addEntry({
    kind: "transfer",
    title: "Transfer",
    amount,
    note: note.trim(),
    fromAccountId,
    toAccountId,
    status: "paid",
    paidAt: paidAt || new Date().toISOString(),
    recurrence: "one-time",
    dueDate: null,
    category: null,
  });
}

export async function updateEntry(id, patch) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return null;
  Object.assign(e, patch);
  if (e.kind === "expense" && e.recurrence !== "one-time" && !e.seriesId) e.seriesId = e.id;
  await saveLedger();
  emit();
  return e;
}

/** Delete one entry. Returns it for undo. */
export async function deleteEntry(id) {
  const i = state.entries.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [removed] = state.entries.splice(i, 1);
  await saveLedger();
  emit();
  return removed;
}

/** Delete this instance and all future pending instances; stop the series. */
export async function deleteSeriesFuture(id) {
  const target = state.entries.find((x) => x.id === id);
  if (!target || !target.seriesId) return deleteEntry(id);
  const sid = target.seriesId;
  const cutoff = target.dueDate || isoDate();
  const removed = state.entries.filter(
    (x) => x.seriesId === sid && x.status === "pending" && (x.dueDate || "") >= cutoff
  );
  state.entries = state.entries.filter((x) => !removed.includes(x));
  const ended = (await getMeta("endedSeries")) || [];
  if (!ended.includes(sid)) { ended.push(sid); await setMeta("endedSeries", ended); }
  await saveLedger();
  emit();
  return removed;
}

export async function restoreEntries(list) {
  state.entries.push(...list);
  await saveLedger();
  emit();
}

export async function markPaid(id) {
  return updateEntry(id, { status: "paid", paidAt: new Date().toISOString() });
}
export async function unmarkPaid(id) {
  return updateEntry(id, { status: "pending", paidAt: null });
}

/** Replace the whole ledger (import / sync pull). Accepts {entries, accounts}. */
export async function replaceAll(data) {
  state.entries = data?.entries || [];
  state.accounts = data?.accounts || [];
  await saveLedger();
  emit();
}

/** Merge by id — existing entries/accounts win. Returns count of entries added. */
export async function mergeData(data) {
  const have = new Set(state.entries.map((e) => e.id));
  const add = (data?.entries || []).filter((e) => e && e.id && !have.has(e.id));
  state.entries.push(...add);
  const haveAcc = new Set(state.accounts.map((a) => a.id));
  state.accounts.push(...(data?.accounts || []).filter((a) => a && a.id && !haveAcc.has(a.id)));
  await saveLedger();
  emit();
  return add.length;
}

/* ---- accounts ---- */

export async function addAccount(name, kind, startingBalance = 0) {
  const acc = { id: uuid(), name: name.trim(), kind };
  state.accounts.push(acc);
  if (startingBalance > 0) {
    state.entries.push({
      ...blank(),
      kind: "income",
      title: "Starting balance",
      amount: startingBalance,
      status: "paid",
      paidAt: new Date().toISOString(),
      accountId: acc.id,
      isAdjustment: true,
    });
  }
  await saveLedger();
  emit();
  return acc;
}

export async function updateAccount(id, patch) {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) return null;
  Object.assign(a, patch);
  await saveLedger();
  emit();
  return a;
}

/** Reorder accounts to match `orderedIds` — this array order IS the display order everywhere. */
export async function reorderAccounts(orderedIds) {
  const byId = new Map(state.accounts.map((a) => [a.id, a]));
  const next = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  for (const a of state.accounts) if (!orderedIds.includes(a.id)) next.push(a); // safety: never drop one
  state.accounts = next;
  await saveLedger();
  emit();
}

/**
 * Remove an account AND every entry tied to it (income, paid expenses,
 * pending expenses, adjustment entries) — one atomic state change + save,
 * so hero totals and committed figures drop with it instead of an orphaned
 * entry still counting toward balances(). Returns { account, entries } (both
 * removed) for undo via restoreAccountWithEntries, or null if not found.
 */
export async function removeAccountWithEntries(id) {
  const idx = state.accounts.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const [account] = state.accounts.splice(idx, 1);
  const touches = (e) => e.accountId === id || e.fromAccountId === id || e.toAccountId === id;
  const entries = state.entries.filter(touches);
  state.entries = state.entries.filter((e) => !touches(e));
  await saveLedger();
  emit();
  return { account, entries };
}

/** Undo counterpart to removeAccountWithEntries: puts the account and its
 * entries straight back. */
export async function restoreAccountWithEntries({ account, entries }) {
  state.accounts.push(account);
  state.entries.push(...entries);
  await saveLedger();
  emit();
}

/** Real money in one account: its income minus its paid expenses. */
export function accountBalance(id) {
  let v = 0;
  for (const e of state.entries) {
    if (e.kind === "transfer") {
      if (e.fromAccountId === id) v -= e.amount;
      if (e.toAccountId === id) v += e.amount;
      continue;
    }
    if (e.accountId !== id) continue;
    if (e.kind === "income") { if (e.status === "paid") v += e.amount; }
    else if (e.status === "paid") v -= e.amount;
  }
  return v;
}

/**
 * Bucket-fill breakdown for one account: real balance, how much of it is
 * already spoken for by pending (unpaid) expenses on that account, and what's
 * actually free to spend. Pure/additive — leans on accountBalance() above.
 */
export function accountBreakdown(id) {
  const balance = accountBalance(id);
  let committed = 0;
  for (const e of state.entries) {
    if (e.accountId === id && e.kind === "expense" && e.status === "pending") committed += e.amount;
  }
  return { balance, committed, usable: balance - committed };
}

/**
 * Fix balance: user says what the account ACTUALLY has; the difference is
 * recorded as a visible adjustment entry so history stays honest.
 * Returns the adjustment entry (or null if already matching).
 */
export async function reconcileAccount(id, actualAmount) {
  const diff = Math.round((actualAmount - accountBalance(id)) * 100) / 100;
  if (!diff) return null;
  const entry = {
    ...blank(),
    kind: diff > 0 ? "income" : "expense",
    title: "Balance fix",
    amount: Math.abs(diff),
    status: "paid",
    paidAt: new Date().toISOString(),
    accountId: id,
    isAdjustment: true,
    note: "Recorded via Fix balance",
  };
  state.entries.push(entry);
  await saveLedger();
  emit();
  return entry;
}

// ---- balance math (the heart) ----
export function balances() {
  let income = 0, paidOut = 0, committed = 0;
  for (const e of state.entries) {
    if (e.kind === "transfer") continue; // nets to zero across the whole ledger
    if (e.kind === "income") { if (e.status === "paid") income += e.amount; continue; }
    if (e.status === "paid") paidOut += e.amount; else committed += e.amount;
  }
  const total = income - paidOut;
  return { total, committed, free: total - committed };
}

export function pendingExpenses() {
  return state.entries
    .filter((e) => e.kind === "expense" && e.status === "pending")
    .sort((a, b) => {
      const da = a.dueDate || "9999", db_ = b.dueDate || "9999";
      const oa = daysUntil(da) < 0, ob = daysUntil(db_) < 0;
      if (oa !== ob) return oa ? -1 : 1; // overdue first
      return da < db_ ? -1 : da > db_ ? 1 : 0;
    });
}

/** Entries belonging to "YYYY-MM": expenses by dueDate (fallback createdAt), income by date received
 * (fallback expected date for pending income), transfers by their (always-set) paidAt. */
export function entriesForMonth(ym) {
  return state.entries.filter((e) => {
    const d = e.kind === "transfer" ? (e.paidAt || e.createdAt)
      : e.kind === "income" ? (e.paidAt || e.dueDate || e.createdAt)
      : (e.dueDate || e.paidAt || e.createdAt);
    return String(d).slice(0, 7) === ym;
  });
}

export function monthSummary(ym) {
  const list = entriesForMonth(ym);
  let inc = 0, out = 0, recurringOut = 0, onceOut = 0;
  const byCat = {};
  for (const e of list) {
    if (e.kind === "transfer") continue; // not real income/spending — just moved between own accounts
    if (e.kind === "income") { if (e.status === "paid") inc += e.amount; continue; }
    if (e.status !== "paid") continue; // spend = actually paid
    out += e.amount;
    byCat[e.category] = (byCat[e.category] || 0) + e.amount;
    if (e.recurrence === "one-time") onceOut += e.amount; else recurringOut += e.amount;
  }
  return { income: inc, spent: out, net: inc - out, byCat, recurringOut, onceOut, list };
}

// ---- recurrence engine ----
function nextDue(iso, recurrence) {
  const d = parseDay(iso);
  if (recurrence === "weekly") {
    d.setDate(d.getDate() + 7);
  } else {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const max = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, max)); // Jan 31 -> Feb 28
  }
  return isoDate(d);
}

/**
 * On app open: for each live series, if the next due date has passed or falls
 * within the next 7 days and no instance exists for that period, create a
 * pending instance. Never auto-marks anything paid.
 */
export async function materializeRecurring() {
  const ended = new Set((await getMeta("endedSeries")) || []);
  const horizon = isoDate(new Date(Date.now() + 7 * 86400000));
  const series = new Map();
  for (const e of state.entries) {
    if (e.kind !== "expense" || e.recurrence === "one-time" || !e.seriesId) continue;
    if (ended.has(e.seriesId)) continue;
    const cur = series.get(e.seriesId);
    if (!cur || (e.dueDate || "") > (cur.dueDate || "")) series.set(e.seriesId, e);
  }
  let created = 0;
  for (const latest of series.values()) {
    if (!latest.dueDate) continue;
    let due = nextDue(latest.dueDate, latest.recurrence);
    let guard = 0;
    while (due <= horizon && guard++ < 26) {
      state.entries.push({
        ...latest,
        id: uuid(),
        dueDate: due,
        status: "pending",
        paidAt: null,
        createdAt: new Date().toISOString(),
      });
      created++;
      due = nextDue(due, latest.recurrence);
    }
  }
  return created;
}
