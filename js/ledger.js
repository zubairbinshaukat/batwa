// The ledger: entries CRUD, balance math, recurrence engine.
// Entries live in memory while unlocked; every change re-encrypts to IndexedDB.

import { dbGet, dbPut, getMeta, setMeta } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";
import { getKey } from "./auth.js";
import { uuid } from "./util/dom.js";
import { isoDate, parseDay, daysUntil, entryDate } from "./util/format.js";
import { RESERVED_CATEGORY, CATEGORY_MAX, normalizeCategoryName, findCategoryIn, isReservedName } from "./util/category.js";

// Re-exported so the rest of the app has one import site for category rules.
export { RESERVED_CATEGORY, CATEGORY_MAX, normalizeCategoryName };

export const DEFAULT_CATEGORIES = [
  "Fees", "Rent/Hostel", "Food", "Transport", "Education",
  "Bills", "Health", "Shopping", "Savings", "Others",
];

export const state = {
  entries: [],
  accounts: [],   // { id, name, kind } — kind picks the logo
  categories: [...DEFAULT_CATEGORIES],
  limits: {},     // category -> monthly cap (meta `catLimits`, never in the blob)
  // category -> icon name (meta `catIcons`). Meta, like `categories` itself:
  // an icon name reveals nothing the category name does not already reveal.
  catIcons: {},

  /* ---- shared spaces (see js/spaces.js) --------------------------------
     All three live INSIDE the encrypted blob, next to entries and accounts:
     a bundle carries the write token and the data key for one space, so it is
     exactly as secret as the ledger itself, and it travels in backups and via
     personal sync without any new plumbing. Nothing here is ever written to
     `meta` except the notification keys the service worker needs (§7.4).
  --------------------------------------------------------------------- */
  spaces: [],     // SpaceBundle[] — { id, token, key, notifKey, name, color, ... }
  contacts: {},   // localContactId -> { name, links: [{ spaceId, memberId }] }
  profile: null,  // { name, color } — my default display name across spaces
};

// Mirrors meta `remindersOn`. When set, every save republishes the due-date
// counts the service worker reads — see dueSchedule() below.
let remindersOn = false;
export const setRemindersFlag = (on) => { remindersOn = !!on; };

// ---- change notifications (app.js re-renders + schedules sync) ----
const listeners = new Set();
export const onChange = (cb) => listeners.add(cb);
/**
 * Tell everyone the ledger moved. `{ silent: true }` means "the data changed,
 * but the surface that caused it has already repainted itself" — subscribers
 * should refresh badges/pills and skip a full re-render. Subscribers always
 * get the options object, so `cb({ silent })` is safe to destructure.
 */
function emit({ silent = false } = {}) {
  const detail = { silent: !!silent };
  for (const cb of listeners) { try { cb(detail); } catch (e) { console.error(e); } }
}

// ---- persistence ----
export async function saveLedger() {
  const key = getKey();
  if (!key) return;
  const cipher = await encrypt(key, {
    entries: state.entries,
    accounts: state.accounts,
    spaces: state.spaces,
    contacts: state.contacts,
    profile: state.profile,
  });
  await dbPut("entries", "blob", cipher);
  await setMeta("updatedAt", new Date().toISOString());
  // Dates and counts only — the reminder needs them outside the blob, and the
  // SW can read nothing else.
  if (remindersOn) await setMeta("dueSchedule", dueSchedule(state.entries));
}

/**
 * Pending bills grouped by their real due date, within the last 90 / next 60
 * days, ascending. Pure — fixture-tested. No titles, no amounts: this is the
 * only ledger fact that lives outside the encrypted blob.
 */
export function dueSchedule(entries, today = isoDate()) {
  const base = parseDay(today).getTime();
  const from = isoDate(new Date(base - 90 * 86400000));
  const to = isoDate(new Date(base + 60 * 86400000));
  const counts = new Map();
  for (const e of entries || []) {
    if (e.kind !== "expense" || e.status !== "pending" || !e.dueDate) continue;
    const d = String(e.dueDate).slice(0, 10);
    if (d < from || d > to) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, count]) => ({ date, count }));
}

export async function loadLedger() {
  const key = getKey();
  const blob = await dbGet("entries", "blob");
  if (blob && key) {
    const data = await decrypt(key, blob); // throws only if key is wrong — can't be here
    state.entries = data.entries || [];
    state.accounts = data.accounts || [];
    state.spaces = data.spaces || [];
    state.contacts = data.contacts || {};
    state.profile = data.profile || null;
  } else {
    state.entries = [];
    state.accounts = [];
    state.spaces = [];
    state.contacts = {};
    state.profile = null;
  }
  state.categories = (await getMeta("categories")) || [...DEFAULT_CATEGORIES];
  state.limits = (await getMeta("catLimits")) || {};
  state.catIcons = (await getMeta("catIcons")) || {};
  remindersOn = !!(await getMeta("remindersOn"));
  const created = await materializeRecurring();
  if (created) await saveLedger();
}

export async function saveCategories(cats, { silent = false } = {}) {
  const list = [...new Set(cats.map((c) => c.trim()).filter(Boolean))];
  if (!list.includes("Others")) list.push("Others"); // Others always exists
  state.categories = list;
  await setMeta("categories", list);
  // a limit on a category that no longer exists would be invisible forever
  const kept = {};
  for (const [c, v] of Object.entries(state.limits)) if (list.includes(c)) kept[c] = v;
  if (Object.keys(kept).length !== Object.keys(state.limits).length) {
    state.limits = kept;
    await setMeta("catLimits", kept);
  }
  if (!silent) emit();
}

/** Per-category monthly caps. Non-positive or unknown categories are dropped. */
export async function saveLimits(map, { silent = false } = {}) {
  const next = {};
  for (const [c, v] of Object.entries(map || {})) {
    const n = Number(v);
    if (n > 0 && state.categories.includes(c)) next[c] = Math.round(n);
  }
  state.limits = next;
  await setMeta("catLimits", next);
  if (!silent) emit();
}

/* ---- categories: add / rename / delete ------------------------------------
   Names live in meta (`categories`), caps in `catLimits`, icons in `catIcons`.
   A rename is global: it rewrites every entry that carried the old name and
   re-keys both maps, so History, Reports, Home and the month sheet all follow
   without any of them knowing a rename happened.
--------------------------------------------------------------------------- */

/** The stored category matching `name` case-insensitively, or null. */
export const findCategory = (name) => findCategoryIn(state.categories, name);

/** The icon-name override for a category, if the user picked one. */
export const getCatIcon = (name) => state.catIcons[name] || null;

/** How many entries currently sit in this category (for the delete confirm). */
export const countInCategory = (name) =>
  state.entries.reduce((n, e) => n + (e.category === name ? 1 : 0), 0);

/**
 * Create a category. Throws Error("empty" | "reserved" | "duplicate").
 * Inserted just before Others, which always stays last. Resolves to the
 * stored (normalized) name.
 */
export async function addCategory(name, { icon = null, limit = null } = {}) {
  const clean = normalizeCategoryName(name);
  if (!clean) throw new Error("empty");
  if (isReservedName(clean)) throw new Error("reserved");
  if (findCategory(clean)) throw new Error("duplicate");

  const rest = state.categories.filter((c) => c !== RESERVED_CATEGORY);
  await saveCategories([...rest, clean, RESERVED_CATEGORY], { silent: true });

  if (icon) {
    state.catIcons[clean] = icon;
    await setMeta("catIcons", state.catIcons);
  }
  // after saveCategories: saveLimits drops keys that aren't categories yet
  if (Number(limit) > 0) await saveLimits({ ...state.limits, [clean]: Number(limit) }, { silent: true });

  emit();
  return clean;
}

/**
 * Rename / re-icon / re-cap a category. Throws Error("empty" | "reserved" |
 * "duplicate" | "missing"). `Others` accepts an icon change only — its name and
 * cap are ignored rather than rejected, so the same panel works for it.
 * A case-only rename (Food -> food) is allowed. Resolves to the stored name.
 */
export async function updateCategory(oldName, { name, icon, limit } = {}) {
  const locked = oldName === RESERVED_CATEGORY;
  let next = oldName;

  if (!locked) {
    next = normalizeCategoryName(name ?? oldName);
    if (!next) throw new Error("empty");
    if (isReservedName(next)) throw new Error("reserved");
    const clash = findCategory(next);
    if (clash && clash !== oldName) throw new Error("duplicate");
  }

  const i = state.categories.indexOf(oldName);
  if (i < 0) throw new Error("missing");

  if (next !== oldName) {
    state.categories[i] = next;
    for (const e of state.entries) if (e.category === oldName) e.category = next;
    if (oldName in state.limits) { state.limits[next] = state.limits[oldName]; delete state.limits[oldName]; }
    if (oldName in state.catIcons) { state.catIcons[next] = state.catIcons[oldName]; delete state.catIcons[oldName]; }
    await saveLedger();
    await setMeta("categories", state.categories);
    await setMeta("catLimits", state.limits);
    await setMeta("catIcons", state.catIcons);
  }

  if (icon !== undefined) {
    if (icon) state.catIcons[next] = icon;
    else delete state.catIcons[next];
    await setMeta("catIcons", state.catIcons);
  }

  if (!locked && limit !== undefined) {
    const n = Number(limit);
    const map = { ...state.limits };
    if (n > 0) map[next] = n; else delete map[next];
    await saveLimits(map, { silent: true });
  }

  emit();
  return next;
}

/**
 * Delete a category and move its entries to Others — orphaning them would
 * make them vanish from every category view. Returns how many moved.
 * Throws Error("reserved") for Others.
 */
export async function deleteCategory(name) {
  if (name === RESERVED_CATEGORY) throw new Error("reserved");
  if (!state.categories.includes(name)) return 0;

  let moved = 0;
  for (const e of state.entries) {
    if (e.category === name) { e.category = RESERVED_CATEGORY; moved++; }
  }
  if (moved) await saveLedger();

  if (name in state.catIcons) {
    delete state.catIcons[name];
    await setMeta("catIcons", state.catIcons);
  }
  // saveCategories prunes the now-orphaned limit and emits
  await saveCategories(state.categories.filter((c) => c !== name));
  return moved;
}

/**
 * Where each limited category stands in "YYYY-MM", worst first.
 * `daysLeft` is 0 for any month that is not the current one.
 */
export function limitStatus(ym, { today = isoDate() } = {}) {
  const { byCat } = monthSummary(ym);
  const [y, m] = ym.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const daysLeft = ym === today.slice(0, 7) ? Math.max(0, daysInMonth - Number(today.slice(8, 10))) : 0;
  return Object.entries(state.limits)
    .filter(([cat, lim]) => lim > 0 && state.categories.includes(cat))
    .map(([category, limit]) => {
      const spent = byCat[category] || 0;
      return {
        category, limit, spent,
        ratio: limit > 0 ? spent / limit : 0,
        left: Math.max(0, limit - spent),
        over: Math.max(0, spent - limit),
        daysLeft,
      };
    })
    .sort((a, b) => b.ratio - a.ratio);
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

/** Replace the whole ledger (import / sync pull). Accepts {entries, accounts}.
 * `{ silent: true }` for callers that repaint themselves (background pulls). */
export async function replaceAll(data, { silent = false } = {}) {
  state.entries = data?.entries || [];
  state.accounts = data?.accounts || [];
  state.spaces = data?.spaces || [];
  state.contacts = data?.contacts || {};
  state.profile = data?.profile || null;
  await saveLedger();
  emit({ silent });
}

/** Merge by id — existing entries/accounts win. Returns count of entries added. */
export async function mergeData(data, { silent = false } = {}) {
  const have = new Set(state.entries.map((e) => e.id));
  const add = (data?.entries || []).filter((e) => e && e.id && !have.has(e.id));
  state.entries.push(...add);
  const haveAcc = new Set(state.accounts.map((a) => a.id));
  state.accounts.push(...(data?.accounts || []).filter((a) => a && a.id && !haveAcc.has(a.id)));
  // Space bundles merge by id, mine winning: the incoming copy may be older and
  // its `lastVersion` would make the next push fight the relay for nothing.
  const haveSpace = new Set((state.spaces || []).map((s) => s.id));
  state.spaces = [
    ...(state.spaces || []),
    ...(data?.spaces || []).filter((s) => s && s.id && !haveSpace.has(s.id)),
  ];
  state.contacts = { ...(data?.contacts || {}), ...(state.contacts || {}) };
  state.profile = state.profile || data?.profile || null;
  await saveLedger();
  emit({ silent });
  return add.length;
}

/* ---- rows that belong to a shared entry ---------------------------------
   My personal ledger only ever changes through my own actions, so exactly one
   function owns the rows a shared entry produces on this phone: at most one
   `expense` (my share) and at most one `lent` (what I fronted for the others).
   Everything is written in ONE silent save, because the surface that triggered
   it — an accept card, the expense sheet — repaints itself (plan §9.29).
-------------------------------------------------------------------------- */

/** My rows for one shared entry, in ledger order. */
export const rowsForShared = (spaceId, sharedEntryId) =>
  state.entries.filter((e) => e.spaceId === spaceId && e.sharedEntryId === sharedEntryId);

/** Every row of mine that came from a space at all. */
export const sharedRows = () => state.entries.filter((e) => !!e.spaceId);

/**
 * Make my rows for one shared entry exactly `rows` (keyed by `kind`), keeping
 * each surviving row's id and anything it already carried — `repaid` on a lent
 * row above all. An empty list removes them, which is what a reject does.
 */
export async function setSharedRows(spaceId, sharedEntryId, rows) {
  const keep = [];
  const old = new Map();
  for (const e of state.entries) {
    if (e.spaceId === spaceId && e.sharedEntryId === sharedEntryId) old.set(e.kind, e);
    else keep.push(e);
  }
  const next = rows.map((r) => {
    const prev = old.get(r.kind);
    return prev ? { ...prev, ...r } : { ...blank(), ...r, spaceId, sharedEntryId };
  });
  state.entries = [...keep, ...next];
  await saveLedger();
  emit({ silent: true });
  return next;
}

/**
 * Persist a change to `spaces` / `contacts` / `profile`. Always a silent emit:
 * shared-space work repaints its own surface and must never re-render the page
 * out from under an open sheet (plan §9.29).
 */
export async function saveSpaces({ silent = true } = {}) {
  await saveLedger();
  emit({ silent });
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

/* ---- shared-space kinds -----------------------------------------------
   `lent`       money I fronted for other people in a space. It has left my
                account (so it is NOT spending — it is a receivable) and comes
                back through `repaid` as they settle.
   `settlement` money moved between me and a person, `direction: "in" | "out"`.
                Never spending, never income — just a transfer with a human on
                the other end.
   Both carry `spaceId` and `sharedEntryId` so History and the space screen can
   find each other, and both are excluded from every spending figure.
---------------------------------------------------------------------- */

/** What is still out on a `lent` row: amount minus whatever came back. */
export const outstandingOf = (e) =>
  Math.max(0, (Number(e?.amount) || 0) - (Number(e?.repaid) || 0));

/**
 * Part-payment on a still-pending expense (plan §9.11). Settling Rs 400 of a
 * Rs 1,000 share really moves Rs 400 out of an account while the other Rs 600
 * stays a debt, so the row carries `paidPartial` and every figure below splits
 * it: the paid part behaves like a paid expense, the rest like a pending one.
 * Only ever set on `status: "pending"` rows — a full payment flips the status.
 */
export const partialOf = (e) =>
  e?.status === "pending" ? Math.min(Number(e?.amount) || 0, Math.max(0, Number(e?.paidPartial) || 0)) : 0;

/** What a pending expense still owes: its amount minus anything part-paid. */
export const stillOwedOf = (e) => Math.max(0, (Number(e?.amount) || 0) - partialOf(e));

/**
 * A write-off (plan §9.18) is a `settlement` row that never touched an
 * account: it cancels a receivable rather than collecting it. It is kept out
 * of the settled-in/out figures and given its own line, because counting it as
 * money that arrived would hand the user back the rupees they just gave up on.
 */
export const isWriteoff = (e) => e?.kind === "settlement" && !!e.writeoff;

/**
 * One save, one silent emit, for the several rows a settlement touches at
 * once: the pending shares it clears, the lent rows it repays, the settlement
 * row itself. Doing them one updateEntry() at a time would re-encrypt the blob
 * five times and fire five renders at whatever surface is open.
 * `patch` is `[{ id, ...fields }]`, `add` is whole rows.
 */
export async function writeRows({ patch = [], add = [] } = {}) {
  const byId = new Map(state.entries.map((e) => [e.id, e]));
  for (const p of patch) {
    const row = byId.get(p.id);
    if (row) Object.assign(row, p);
  }
  for (const row of add) state.entries.push({ ...blank(), ...row });
  await saveLedger();
  emit({ silent: true });
  return state.entries;
}

/** Real money in one account: its income minus its paid expenses. */
export function accountBalance(id) {
  let v = 0;
  for (const e of state.entries) {
    switch (e.kind) {
      case "transfer":
        if (e.fromAccountId === id) v -= e.amount;
        if (e.toAccountId === id) v += e.amount;
        continue;
      case "income":
        if (e.accountId === id && e.status === "paid") v += e.amount;
        continue;
      case "expense":
        if (e.accountId !== id) continue;
        // A part-paid pending share has moved exactly that much out of here.
        v -= e.status === "paid" ? e.amount : partialOf(e);
        continue;
      case "lent":
        // The cash left this account the day it was fronted, all of it. What
        // comes back arrives as its own `settlement` in row, into whichever
        // account the repayment actually landed in — which is not necessarily
        // this one. Netting `repaid` off here as well would credit the money
        // twice, and always to the wrong account (plan §6).
        if (e.accountId === id) v -= Number(e.amount) || 0;
        continue;
      case "settlement":
        // A write-off never landed anywhere, so it moves no account.
        if (e.accountId !== id || isWriteoff(e)) continue;
        v += e.direction === "in" ? Number(e.amount) || 0 : -(Number(e.amount) || 0);
        continue;
      default:
        continue; // a kind this build doesn't know moves no money it can account for
    }
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
    switch (e.kind) {
      case "expense":
        if (e.accountId === id && e.status === "pending") committed += stillOwedOf(e);
        continue;
      case "income":
      case "transfer":
      case "lent":
      case "settlement":
        continue; // none of these can be "committed" against an account
      default:
        continue;
    }
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
/**
 * free = income − paidExpenses − lentCash − settlementsOut
 *        + settlementsIn − committed                    (plan §5.2, §6)
 * `total` is real money: everything above except the committed line, which is
 * money that has not moved yet.
 *
 * The plan's §5.2 sketch nets `lent` off by its OUTSTANDING half. M4 cannot:
 * once a repayment also writes a `settlement` in row — which it must, because
 * only the receiver knows which account the money landed in — the same rupees
 * would come back twice, once through `repaid` and once through the row. So
 * `lent` is cash gone in full and repayments return only through settlements.
 * `lentOut` stays the OUTSTANDING figure, because that is what Reports means
 * by "lent out": a receivable, not a cash movement.
 *
 * A write-off (§9.18) therefore needs no counterweight at all: it closes the
 * receivable without pretending any cash arrived, which is exactly the truth.
 */
export function balances() {
  let income = 0, paidOut = 0, committed = 0;
  let lentCash = 0, lentOut = 0, settledOut = 0, settledIn = 0, writtenOff = 0;
  for (const e of state.entries) {
    switch (e.kind) {
      case "transfer":
        continue; // nets to zero across the whole ledger
      case "income":
        if (e.status === "paid") income += e.amount;
        continue;
      case "expense":
        if (e.status === "paid") { paidOut += e.amount; continue; }
        // A part-paid pending share is both at once: what has gone has gone.
        paidOut += partialOf(e);
        committed += stillOwedOf(e);
        continue;
      case "lent":
        lentCash += Number(e.amount) || 0;
        lentOut += outstandingOf(e);
        continue;
      case "settlement":
        // A write-off is not cash: it only closes a receivable.
        if (isWriteoff(e)) writtenOff += Number(e.amount) || 0;
        else if (e.direction === "in") settledIn += Number(e.amount) || 0;
        else settledOut += Number(e.amount) || 0;
        continue;
      default:
        continue; // unknown kind: counted nowhere until it has a rule of its own
    }
  }
  const total = income - paidOut - lentCash - settledOut + settledIn;
  return { total, committed, free: total - committed, lentCash, lentOut, settledOut, settledIn, writtenOff };
}

/**
 * The three figures the Reports "Shared" card shows. Pure over `state.entries`:
 *   lentOut    still out on my `lent` rows, all time
 *   owed       my pending shares that name someone else as the payer
 *   settled    settlement money that moved either way inside `ym`
 */
export function sharedTotals(ym) {
  let lentOut = 0, owed = 0, settled = 0, settledIn = 0, settledOut = 0, writtenOff = 0;
  for (const e of state.entries) {
    switch (e.kind) {
      case "lent":
        lentOut += outstandingOf(e);
        continue;
      case "expense":
        if (e.status === "pending" && e.owedTo) owed += stillOwedOf(e);
        continue;
      case "settlement": {
        if (entryDate(e).slice(0, 7) !== ym) continue;
        // Written-off money was never settled; it was given up on.
        if (isWriteoff(e)) { writtenOff += Number(e.amount) || 0; continue; }
        const v = Number(e.amount) || 0;
        settled += v;
        if (e.direction === "in") settledIn += v; else settledOut += v;
        continue;
      }
      default:
        continue;
    }
  }
  return { lentOut, owed, settled, settledIn, settledOut, writtenOff };
}

/**
 * Can this row be deleted outright? A `lent` row that has already been partly
 * repaid cannot: deleting it would erase money that came back (plan §9.13).
 */
export function deleteBlockedReason(e) {
  if (e?.kind === "lent" && (Number(e.repaid) || 0) > 0) return "repaid";
  return null;
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

/** Entries belonging to "YYYY-MM". The per-kind date rule lives in
 * entryDate() (util/format.js) — History and Reports bucket by the same one. */
export function entriesForMonth(ym) {
  return state.entries.filter((e) => {
    switch (e.kind) {
      case "expense":
      case "income":
      case "transfer":
      case "lent":
      case "settlement":
        return entryDate(e).slice(0, 7) === ym;
      default:
        return false; // unknown kind: it belongs to no month this build can show
    }
  });
}

export function monthSummary(ym) {
  const list = entriesForMonth(ym);
  let inc = 0, out = 0, recurringOut = 0, onceOut = 0;
  const byCat = {};
  for (const e of list) {
    switch (e.kind) {
      case "transfer":
        continue; // not real income/spending — just moved between own accounts
      case "income":
        if (e.status === "paid") inc += e.amount;
        continue;
      case "expense":
        break; // falls through to the spend math below
      case "lent":
      case "settlement":
        continue; // money that moved between people, never spending or income
      default:
        continue; // unknown kind: neither income nor spending
    }
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
