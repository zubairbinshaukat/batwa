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

/** Compact: 54302 -> "54.3k", 1240000 -> "1.24M", 812 -> "812". Sign preserved. */
export function fmtCompact(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a < 1000) return sign + fmtNum(a);
  const one = (x) => {
    const s = x.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (a < 1e6) return `${sign}${one(a / 1e3)}k`;
  const s = (a / 1e6).toFixed(2).replace(/\.?0+$/, "");
  return `${sign}${s}M`;
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

/** time-of-day greeting */
export function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
