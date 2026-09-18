// Pure spending analysis for one month: data in, facts out.
// No DOM, no ledger import — so it runs under plain Node and can be smoke-tested
// on its own. The UI turns these facts into sentences; this file never does.

import { isoDate, shiftMonth, weekdayIndex, entryDate } from "./util/format.js";

const TOP_N = 3;

/** The one date a spend belongs to — literally entryDate(), re-exported under
 * the name Reports already imports. The rule lives in util/format.js. */
export const spendDate = entryDate;

/** Spending = paid expenses. Transfers and income are not spending. */
export function isSpend(e) {
  return !!e && e.kind === "expense" && e.status === "paid";
}

function amountOf(e) {
  return Number(e.amount) || 0;
}

function monthOf(iso) {
  return String(iso).slice(0, 7);
}

function daysInMonthOf(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

function titleKey(title) {
  const k = String(title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return k || "untitled";
}

function spendsIn(entries, ym) {
  return entries.filter((e) => isSpend(e) && monthOf(spendDate(e)) === ym);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Group paid expenses by normalised title; the newest entry supplies the display fields. */
function groupTitles(list) {
  const map = new Map();
  for (const e of list) {
    const key = titleKey(e.title);
    let g = map.get(key);
    if (!g) {
      g = { key, title: "", category: "Others", recurrence: "one-time", isAdjustment: false, total: 0, count: 0, avg: 0, entries: [] };
      map.set(key, g);
    }
    g.total += amountOf(e);
    g.count++;
    g.entries.push(e);
  }
  for (const g of map.values()) {
    g.entries.sort((a, b) => {
      const da = spendDate(a), db = spendDate(b);
      return da < db ? -1 : da > db ? 1 : 0;
    });
    const newest = g.entries[g.entries.length - 1];
    g.title = String(newest.title || "").trim() || "Untitled";
    g.category = newest.category || "Others";
    g.recurrence = newest.recurrence || "one-time";
    g.isAdjustment = g.entries.some((e) => !!e.isAdjustment);
    g.avg = g.count ? g.total / g.count : 0;
  }
  return map;
}

/**
 * One month, day by day. Same rule as everywhere else: a spend is a PAID
 * expense, bucketed by spendDate() — never re-derived here.
 * -> { days: Map<"YYYY-MM-DD", { total, list }>, total }
 */
export function dailySpend(entries, ym) {
  const days = new Map();
  let total = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isSpend(e)) continue;
    const d = spendDate(e);
    if (monthOf(d) !== ym) continue;
    let b = days.get(d);
    if (!b) { b = { total: 0, list: [] }; days.set(d, b); }
    const v = amountOf(e);
    b.total += v;
    b.list.push(e);
    total += v;
  }
  for (const b of days.values()) {
    b.list.sort((a, c) => amountOf(c) - amountOf(a));
  }
  return { days, total };
}

/**
 * Everything the Reports page needs to know about one month of spending.
 * `entries` is the whole ledger; this filters to paid expenses in `ym`.
 * Every array exists even when empty and every division guards zero, so the
 * caller can read the shape without defensive checks.
 */
export function analyzeMonth(entries, ym, { today = isoDate() } = {}) {
  const all = Array.isArray(entries) ? entries : [];
  const list = spendsIn(all, ym);
  const daysInMonth = daysInMonthOf(ym);
  const curYm = monthOf(today);
  const isCurrent = ym === curYm;
  const daysElapsed = isCurrent
    ? Math.min(daysInMonth, Math.max(0, Number(String(today).slice(8, 10)) || 0))
    : ym < curYm ? daysInMonth : 0; // a future month has not happened yet

  let spent = 0;
  for (const e of list) spent += amountOf(e);
  const shareOf = (v) => (spent > 0 ? v / spent : 0);

  // ---- titles ----
  const titles = [...groupTitles(list).values()]
    .map((g) => ({ ...g, share: shareOf(g.total) }))
    .sort((a, b) => b.total - a.total);

  // ---- single biggest payment ----
  let biggest = null;
  for (const e of list) {
    if (!biggest || amountOf(e) > amountOf(biggest)) biggest = e;
  }
  const largest = biggest ? { entry: biggest, share: shareOf(amountOf(biggest)) } : null;

  // ---- how much of the month a handful of things decide ----
  const topTitles = titles.slice(0, TOP_N);
  const concentration = topTitles.length
    ? { topN: topTitles.length, share: shareOf(topTitles.reduce((s, t) => s + t.total, 0)), titles: topTitles }
    : null;

  // ---- small things done often ----
  const habits = titles
    .filter((t) => t.count >= 4)
    .sort((a, b) => b.count - a.count || b.total - a.total)
    .map((t) => ({ key: t.key, title: t.title, count: t.count, total: t.total, avg: t.avg, share: t.share }));

  // ---- weekday shape (0 = Mon … 6 = Sun) ----
  const wTotals = new Array(7).fill(0);
  const wCounts = new Array(7).fill(0);
  const wElapsed = new Array(7).fill(0);
  for (const e of list) {
    const i = weekdayIndex(spendDate(e));
    if (i < 0) continue;
    wTotals[i] += amountOf(e);
    wCounts[i]++;
  }
  const firstIdx = weekdayIndex(`${ym}-01`);
  if (firstIdx >= 0) for (let d = 0; d < daysElapsed; d++) wElapsed[(firstIdx + d) % 7]++;
  const wPerDay = wTotals.map((t, i) => (wElapsed[i] ? t / wElapsed[i] : 0));
  let topIndex = -1;
  wPerDay.forEach((v, i) => { if (v > 0 && (topIndex < 0 || v > wPerDay[topIndex])) topIndex = i; });
  const weTotal = wTotals[5] + wTotals[6];
  const weDays = wElapsed[5] + wElapsed[6];
  const wdTotal = wTotals.slice(0, 5).reduce((s, v) => s + v, 0);
  const wdDays = wElapsed.slice(0, 5).reduce((s, v) => s + v, 0);
  const weekendPerDay = weDays ? weTotal / weDays : null;
  const weekdayPerDay = wdDays ? wdTotal / wdDays : null;
  const weekday = {
    totals: wTotals, counts: wCounts, daysElapsed: wElapsed, perDay: wPerDay, topIndex,
    weekendPerDay, weekdayPerDay,
    ratio: weekendPerDay != null && weekdayPerDay ? weekendPerDay / weekdayPerDay : null,
  };

  // ---- where in the month the money went ----
  let early = 0, mid = 0, late = 0;
  for (const e of list) {
    const day = Number(spendDate(e).slice(8, 10)) || 0;
    if (day <= 10) early += amountOf(e);
    else if (day <= 20) mid += amountOf(e);
    else late += amountOf(e);
  }
  const phase = { early, mid, late, shares: { early: shareOf(early), mid: shareOf(mid), late: shareOf(late) } };

  // ---- day by day ----
  const byDay = new Map();
  for (const e of list) {
    const d = spendDate(e);
    let b = byDay.get(d);
    if (!b) { b = { date: d, total: 0, entries: [] }; byDay.set(d, b); }
    b.total += amountOf(e);
    b.entries.push(e);
  }
  const days = [...byDay.values()].filter((b) => b.total > 0);
  const peak = days.reduce((best, b) => (!best || b.total > best.total ? b : best), null);
  const avg = daysElapsed ? spent / daysElapsed : 0;
  const daily = {
    avg,
    median: median(days.map((b) => b.total)),
    spendDays: days.length,
    noSpendDays: Math.max(0, daysElapsed - days.length),
    peak: peak ? { date: peak.date, total: peak.total, entries: peak.entries } : null,
  };

  // ---- last month, for pace and risers ----
  const prevList = spendsIn(all, shiftMonth(ym, -1));
  let prevSpent = 0;
  for (const e of prevList) prevSpent += amountOf(e);
  const projection = isCurrent ? { projected: avg * daysInMonth, prevSpent } : null;

  const prevGroups = groupTitles(prevList);
  const risers = [];
  for (const t of titles) {
    const p = prevGroups.get(t.key);
    if (!p || p.total <= 0) continue;
    const diff = t.total - p.total;
    const pct = (diff / p.total) * 100;
    if (diff > 0 && pct >= 20 && diff >= 0.05 * spent) {
      risers.push({ key: t.key, title: t.title, cur: t.total, prev: p.total, diff, pct });
    }
  }
  risers.sort((a, b) => b.diff - a.diff);

  const known = new Set();
  for (let i = 1; i <= 3; i++) {
    for (const e of spendsIn(all, shiftMonth(ym, -i))) known.add(titleKey(e.title));
  }
  const newcomers = titles
    .filter((t) => !known.has(t.key))
    .map((t) => ({ key: t.key, title: t.title, total: t.total }))
    .sort((a, b) => b.total - a.total);

  // ---- balance fixes: real money, but money the user could not trace ----
  let adjTotal = 0, adjCount = 0;
  for (const e of list) {
    if (!e.isAdjustment) continue;
    adjTotal += amountOf(e);
    adjCount++;
  }

  return {
    ym, spent, count: list.length, daysInMonth, daysElapsed, isCurrent,
    titles, largest, concentration, habits, weekday, phase, daily, projection,
    deltas: { risers, newcomers },
    adjustments: { total: adjTotal, share: shareOf(adjTotal), count: adjCount },
  };
}
