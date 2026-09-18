// Currency + number + date formatting. The one place locale lives.

export const CURRENCY = { symbol: "Rs", locale: "en-PK" };

const nf = new Intl.NumberFormat(CURRENCY.locale, { maximumFractionDigits: 0 });

/** "54302" -> "54,302" (no symbol) */
export function fmtNum(n) {
  return nf.format(Math.round(Number(n) || 0));
}

/** "54302" -> "Rs 54,302" */
export function fmtMoney(n) {
  const v = Math.round(Number(n) || 0);
  return v < 0 ? `-${CURRENCY.symbol} ${nf.format(-v)}` : `${CURRENCY.symbol} ${nf.format(v)}`;
}

/** Compact (Pakistani numbering): 54302 -> "54.3k", 234100 -> "2.34 lacs", 12400000 -> "1.24 cr", 812 -> "812". Sign preserved. */
export function fmtCompact(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a < 1000) return sign + fmtNum(a);
  const one = (x) => {
    const s = x.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  const trim2 = (x) => x.toFixed(2).replace(/\.?0+$/, "");
  if (a < 1e5) return `${sign}${one(a / 1e3)}k`;
  if (a < 1e7) {
    const s = trim2(a / 1e5);
    return `${sign}${s} ${Number(s) === 1 ? "lac" : "lacs"}`;
  }
  const s = trim2(a / 1e7);
  return `${sign}${s} cr`;
}

const DAY = 86400000;

/** Local YYYY-MM-DD for today (or a Date). */
export function isoDate(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** Parse "YYYY-MM-DD" as a local-midnight Date. */
export function parseDay(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Whole days from today to `iso` (negative = past). */
export function daysUntil(iso) {
  const today = parseDay(isoDate());
  return Math.round((parseDay(iso) - today) / DAY);
}

/** "in 3 days" / "Tomorrow" / "Today" / "Overdue by 2 days" */
export function dueHint(iso) {
  const d = daysUntil(iso);
  if (d < 0) return { text: `Overdue by ${-d} day${d === -1 ? "" : "s"}`, tone: "overdue" };
  if (d === 0) return { text: "Due today", tone: "soon" };
  if (d === 1) return { text: "Tomorrow", tone: "soon" };
  if (d <= 3) return { text: `In ${d} days`, tone: "soon" };
  return { text: `In ${d} days`, tone: "ok" };
}

/**
 * The one date an entry belongs to — the key History groups by, Reports bucket
 * by, and entriesForMonth() filters on. One rule per kind, in one place, so the
 * three callers can never drift:
 *   transfer — paidAt (always set on a transfer) else createdAt
 *   income   — paidAt else dueDate (the expected date of pending income) else createdAt
 *   lent     — paidAt else createdAt (money left the account the day it was lent)
 *   settlement — paidAt else createdAt (same: it moved, or it didn't happen)
 *   anything else (expense) — dueDate else paidAt else createdAt
 * Always sliced to "YYYY-MM-DD".
 */
export function entryDate(e) {
  const k = e?.kind;
  const d = k === "transfer" ? (e.paidAt || e.createdAt)
    : k === "income" ? (e.paidAt || e.dueDate || e.createdAt)
    : k === "lent" || k === "settlement" ? (e.paidAt || e.createdAt)
    : (e?.dueDate || e?.paidAt || e?.createdAt);
  return String(d).slice(0, 10);
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/** "2026-08" -> "August 2026" */
export function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2026-08-07" -> "7 Aug" */
export function shortDate(iso) {
  const d = parseDay(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

/** Weekday headers, Monday first — the order the month grid uses. */
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday = 0 … Sunday = 6. -1 when the date is unusable. */
export function weekdayIndex(iso) {
  const d = parseDay(iso);
  if (Number.isNaN(d.getTime())) return -1;
  return (d.getDay() + 6) % 7;
}

/** "2026-09-17" -> "Thu 17 Sep" */
export function dayLabel(iso) {
  const i = weekdayIndex(iso);
  if (i < 0) return "";
  return `${DAYS[i]} ${shortDate(iso)}`;
}

/** "Today · Thu 17 Sep" / "Yesterday · …" / plain dayLabel */
export function relDayLabel(iso) {
  const d = daysUntil(iso);
  const base = dayLabel(iso);
  if (d === 0) return `Today · ${base}`;
  if (d === -1) return `Yesterday · ${base}`;
  if (d === 1) return `Tomorrow · ${base}`;
  return base;
}

/** current "YYYY-MM" */
export function thisMonth() {
  return isoDate().slice(0, 7);
}

/** shift "YYYY-MM" by n months */
export function shiftMonth(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "Synced 4 minutes ago" style */
export function timeAgo(ts) {
  if (!ts) return "Never synced";
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "Synced just now";
  if (s < 3600) return `Synced ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `Synced ${Math.floor(s / 3600)} hr ago`;
  return `Synced ${Math.floor(s / 86400)} day${s < 172800 ? "" : "s"} ago`;
}

/** "just now" / "4 min ago" / "2 hr ago" / "3 days ago" — no "Synced" prefix. */
export function agoLabel(ts) {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  const d = Math.floor(s / 86400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** time-of-day greeting */
export function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
