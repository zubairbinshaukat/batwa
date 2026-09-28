// Pure report builders for the Reports "Get data" flow.
// No DOM, no ledger import — Node can import and fixture-test this file.
// Text + CSV live here; XLSX styling is built once ExcelJS is supplied.

import {
  entryDate, fmtMoney, isoDate, parseDay, shiftMonth,
} from "./util/format.js";

const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const PURE_NUMBER = /^[+-]?\d+(\.\d+)?$/;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Inclusive default range for the Reports month currently on screen. */
export function defaultRangeForMonth(ym, today = isoDate()) {
  const cur = today.slice(0, 7);
  const from = `${ym}-01`;
  if (ym === cur) return { from, to: today };
  if (ym > cur) return { from: today, to: today };
  return { from, to: lastDayOfMonth(ym) };
}

/** Preset → inclusive { from, to }. Unknown presets fall back to this month. */
export function rangeForPreset(preset, { today = isoDate() } = {}) {
  const curYm = today.slice(0, 7);
  switch (preset) {
    case "this_month":
      return { from: `${curYm}-01`, to: today };
    case "last_7":
      return { from: addDays(today, -6), to: today };
    case "last_30":
      return { from: addDays(today, -29), to: today };
    case "last_month": {
      const prev = shiftMonth(curYm, -1);
      return { from: `${prev}-01`, to: lastDayOfMonth(prev) };
    }
    case "custom":
      return null;
    default: {
      const _exhaustive = preset;
      void _exhaustive;
      return { from: `${curYm}-01`, to: today };
    }
  }
}

/**
 * Validate an inclusive range. Returns { ok, from, to, error }.
 * Clamps `to` so it never sits past `today`.
 */
export function normalizeRange(from, to, today = isoDate()) {
  const f = String(from || "").slice(0, 10);
  const t = String(to || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return { ok: false, from: f, to: t, error: "Pick a valid from and to date." };
  }
  if (Number.isNaN(parseDay(f).getTime()) || Number.isNaN(parseDay(t).getTime())) {
    return { ok: false, from: f, to: t, error: "Pick a valid from and to date." };
  }
  let a = f;
  let b = t;
  if (a > b) [a, b] = [b, a];
  if (b > today) b = today;
  if (a > today) a = today;
  if (a > b) {
    return { ok: false, from: a, to: b, error: "That range is in the future." };
  }
  return { ok: true, from: a, to: b, error: null };
}

/**
 * Build the report model from raw ledger entries.
 * `accountNameOf(id)` should return a display name or null/"" for missing.
 */
export function buildReport(entries, {
  from,
  to,
  includeAdjustments = true,
  accountNameOf = () => "",
  generatedAt = new Date(),
} = {}) {
  const range = normalizeRange(from, to);
  if (!range.ok) {
    return emptyReport(range.from, range.to, includeAdjustments, generatedAt, range.error);
  }

  const rows = [];
  for (const e of entries || []) {
    if (!isExportable(e, includeAdjustments)) continue;
    const date = entryDate(e);
    if (!date || date < range.from || date > range.to) continue;
    const amount = Math.round(Number(e.amount) || 0);
    if (!amount) continue;
    const signed = e.kind === "income" ? amount : -amount;
    rows.push({
      date,
      time: trustworthyTime(e, date),
      kind: e.kind,
      title: String(e.title || "").trim() || (e.kind === "income" ? "Income" : "Expense"),
      category: String(e.category || "").trim(),
      account: String(accountNameOf(e.accountId) || "").trim(),
      amount: signed,
      absAmount: amount,
      currency: "PKR",
      note: String(e.note || "").trim(),
      adjustment: !!e.isAdjustment,
      id: e.id || "",
    });
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const ta = a.time || "";
    const tb = b.time || "";
    if (ta !== tb) return ta < tb ? 1 : -1;
    return (a.title || "").localeCompare(b.title || "");
  });

  let moneyIn = 0;
  let moneyOut = 0;
  const days = new Set();
  const byCategory = new Map();
  const byAccount = new Map();

  for (const r of rows) {
    days.add(r.date);
    if (r.amount >= 0) moneyIn += r.amount;
    else moneyOut += -r.amount;

    if (r.amount < 0) {
      const cat = r.category || "Others";
      byCategory.set(cat, (byCategory.get(cat) || 0) + r.absAmount);
    }
    const acc = r.account || "No account";
    const bucket = byAccount.get(acc) || { in: 0, out: 0 };
    if (r.amount >= 0) bucket.in += r.amount;
    else bucket.out += r.absAmount;
    byAccount.set(acc, bucket);
  }

  const dayGroups = groupByDay(rows);

  return {
    from: range.from,
    to: range.to,
    includeAdjustments,
    generatedAt: generatedAt instanceof Date ? generatedAt : new Date(generatedAt),
    error: null,
    rows,
    dayGroups,
    moneyIn,
    moneyOut,
    net: moneyIn - moneyOut,
    transactions: rows.length,
    daysRecorded: days.size,
    byCategory: [...byCategory.entries()]
      .map(([name, spent]) => ({ name, spent }))
      .sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name)),
    byAccount: [...byAccount.entries()]
      .map(([name, v]) => ({ name, in: v.in, out: v.out, net: v.in - v.out }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.name.localeCompare(b.name)),
  };
}

function emptyReport(from, to, includeAdjustments, generatedAt, error) {
  return {
    from: from || "",
    to: to || "",
    includeAdjustments,
    generatedAt: generatedAt instanceof Date ? generatedAt : new Date(generatedAt),
    error: error || null,
    rows: [],
    dayGroups: [],
    moneyIn: 0,
    moneyOut: 0,
    net: 0,
    transactions: 0,
    daysRecorded: 0,
    byCategory: [],
    byAccount: [],
  };
}

function isExportable(e, includeAdjustments) {
  if (!e) return false;
  if (e.kind !== "income" && e.kind !== "expense") return false;
  if (e.status !== "paid") return false;
  if (e.isAdjustment && !includeAdjustments) return false;
  return true;
}

/** Show HH:mm only when paidAt matches the report day and is not a synthetic noon. */
export function trustworthyTime(entry, date = entryDate(entry)) {
  const raw = entry?.paidAt;
  if (!raw || !date) return "";
  const paidDay = String(raw).slice(0, 10);
  if (paidDay !== date) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  if (d.getHours() === 12 && d.getMinutes() === 0 && d.getSeconds() === 0) return "";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function groupByDay(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.date)) map.set(r.date, []);
    map.get(r.date).push(r);
  }
  return [...map.entries()].map(([date, list]) => ({
    date,
    total: list.reduce((s, r) => s + r.amount, 0),
    rows: list,
  }));
}

/* ============================================================
   Text
   ============================================================ */

export function renderTextReport(report) {
  if (report.error) return `Batwa — Expense Report\n${report.error}\n`;

  const lines = [];
  lines.push("Batwa — Expense Report");
  lines.push(`${formatRangeLabel(report.from, report.to)}`);
  lines.push(`Generated: ${formatLongDate(isoDate(report.generatedAt))}`);
  lines.push("");
  lines.push(`Money in     : ${fmtMoney(report.moneyIn)}`);
  lines.push(`Money out    : ${fmtMoney(report.moneyOut)}`);
  lines.push(`Net          : ${signedMoney(report.net)}`);
  lines.push(`Transactions : ${report.transactions}`);
  lines.push(`Days recorded: ${report.daysRecorded}`);
  if (!report.includeAdjustments) {
    lines.push("Adjustments  : excluded");
  }
  lines.push("");

  if (!report.rows.length) {
    lines.push("No paid income or expenses in this range.");
    lines.push("");
    lines.push("————————————————");
    lines.push(`Total out: ${fmtMoney(0)}`);
    lines.push(`Total in : ${fmtMoney(0)}`);
    return lines.join("\n");
  }

  for (const day of report.dayGroups) {
    lines.push(`----${formatLongDate(day.date)}----`);
    lines.push(`Day total: ${signedMoney(day.total)}`);
    lines.push("");
    for (const r of day.rows) {
      lines.push(formatTextRow(r));
    }
    lines.push("");
  }

  lines.push("————————————————");
  lines.push(`Total out: ${fmtMoney(report.moneyOut)}`);
  lines.push(`Total in : ${fmtMoney(report.moneyIn)}`);
  return lines.join("\n");
}

function formatTextRow(r) {
  const mark = r.adjustment ? "🟡" : r.amount >= 0 ? "🟢" : "🔴";
  const bits = [r.title];
  if (r.category) bits.push(r.category);
  if (r.account) bits.push(r.account);
  let line = `${mark} ${signedMoney(r.amount)} — ${bits.join("  ·  ")}`;
  if (r.time) line += `  (${formatClock(r.time)})`;
  if (r.note) line += `\n   note: ${r.note}`;
  return line;
}

function formatClock(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const am = h < 12;
  const h12 = h % 12 || 12;
  return `${h12}:${pad2(m)} ${am ? "am" : "pm"}`;
}

/* ============================================================
   CSV
   ============================================================ */

export function renderCsvReport(report) {
  const header = ["Date", "Time", "Kind", "Title", "Category", "Account", "Amount", "Currency", "Note", "Adjustment"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of report.rows) {
    lines.push([
      r.date,
      r.time,
      r.kind,
      r.title,
      r.category,
      r.account,
      String(r.amount),
      r.currency || "PKR",
      r.note,
      r.adjustment ? "yes" : "no",
    ].map(csvCell).join(","));
  }
  // BOM helps Excel on Windows recognise UTF-8
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function csvCell(value) {
  let s = String(value ?? "");
  // Neutralize spreadsheet formula injection without mangling signed amounts.
  // Bare numbers like -120 stay numeric; =cmd / +cmd / @sum get a leading quote.
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !PURE_NUMBER.test(s))) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

/* ============================================================
   Filenames / MIME
   ============================================================ */

export function reportFilename(report, ext) {
  const a = (report.from || "start").replaceAll("-", "");
  const b = (report.to || "end").replaceAll("-", "");
  return `batwa-${a}_to_${b}.${ext}`;
}

export function formatRangeLabel(from, to) {
  if (!from || !to) return "";
  if (from === to) return formatLongDate(from);
  return `${formatLongDate(from)} – ${formatLongDate(to)}`;
}

export function formatLongDate(iso) {
  const d = parseDay(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function signedMoney(n) {
  const v = Math.round(Number(n) || 0);
  if (v > 0) return `+${fmtMoney(v)}`;
  return fmtMoney(v);
}

/* ============================================================
   XLSX (ExcelJS injected)
   ============================================================ */

/**
 * Build a styled workbook File. `ExcelJS` is the library constructor namespace
 * (`{ Workbook }`). Totals are precomputed numbers — never formulas.
 */
export async function renderXlsxReport(report, ExcelJS) {
  if (!ExcelJS?.Workbook) throw new Error("Excel library unavailable");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Batwa";
  wb.created = report.generatedAt;
  wb.modified = report.generatedAt;

  paintSummarySheet(wb.addWorksheet(safeSheetName("Summary")), report);
  paintTransactionsSheet(wb.addWorksheet(safeSheetName("Transactions")), report);

  const buffer = await wb.xlsx.writeBuffer();
  const name = reportFilename(report, "xlsx");
  return new File([buffer], name, { type: XLSX_MIME });
}

function paintSummarySheet(ws, report) {
  ws.views = [{ showGridLines: false }];
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 18;

  ws.mergeCells("A1:D1");
  const title = ws.getCell("A1");
  title.value = "Batwa — Expense Report";
  title.font = { name: "Calibri", size: 18, bold: true, color: { argb: "FF4F33E8" } };
  title.alignment = { vertical: "middle" };
  ws.getRow(1).height = 28;

  ws.mergeCells("A2:D2");
  ws.getCell("A2").value = formatRangeLabel(report.from, report.to);
  ws.getCell("A2").font = { name: "Calibri", size: 12, bold: true, color: { argb: "FF1F2937" } };

  ws.mergeCells("A3:D3");
  ws.getCell("A3").value = `Generated ${formatLongDate(isoDate(report.generatedAt))}`;
  ws.getCell("A3").font = { name: "Calibri", size: 10, color: { argb: "FF6B7280" } };

  ws.mergeCells("A4:D4");
  ws.getCell("A4").value = report.includeAdjustments
    ? "Includes starting balances and balance fixes"
    : "Adjustments excluded";
  ws.getCell("A4").font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF6B7280" } };

  const cards = [
    ["Money in", report.moneyIn, "FF059669"],
    ["Money out", report.moneyOut, "FFDC2626"],
    ["Net", report.net, report.net >= 0 ? "FF059669" : "FFDC2626"],
    ["Transactions", report.transactions, "FF4F33E8"],
    ["Days recorded", report.daysRecorded, "FF4F33E8"],
  ];
  let col = 1;
  let row = 6;
  cards.forEach((card, i) => {
    if (i === 3) { row = 9; col = 1; }
    const labelCell = ws.getCell(row, col);
    const valueCell = ws.getCell(row + 1, col);
    labelCell.value = card[0];
    labelCell.font = { name: "Calibri", size: 9, bold: true, color: { argb: "FF6B7280" } };
    labelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F0FF" } };
    valueCell.value = card[1];
    valueCell.font = { name: "Calibri", size: 14, bold: true, color: { argb: card[2] } };
    valueCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F0FF" } };
    if (i < 3) valueCell.numFmt = `"Rs "#,##0;"−Rs "#,##0;"Rs "0`;
    col += 1;
  });

  let r = 12;
  ws.getCell(r, 1).value = "Spending by category";
  ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true, color: { argb: "FF4F33E8" } };
  r += 1;
  styleHeaderRow(ws, r, ["Category", "Spent"]);
  r += 1;
  if (!report.byCategory.length) {
    ws.getCell(r, 1).value = "No spending in this range";
    ws.getCell(r, 1).font = { italic: true, color: { argb: "FF6B7280" } };
    r += 1;
  } else {
    for (const item of report.byCategory) {
      ws.getCell(r, 1).value = asText(item.name);
      ws.getCell(r, 2).value = item.spent;
      ws.getCell(r, 2).numFmt = `"Rs "#,##0`;
      r += 1;
    }
  }

  r += 1;
  ws.getCell(r, 1).value = "Flow by account";
  ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true, color: { argb: "FF4F33E8" } };
  r += 1;
  styleHeaderRow(ws, r, ["Account", "Money in", "Money out", "Net"]);
  r += 1;
  if (!report.byAccount.length) {
    ws.getCell(r, 1).value = "No account activity in this range";
    ws.getCell(r, 1).font = { italic: true, color: { argb: "FF6B7280" } };
  } else {
    for (const item of report.byAccount) {
      ws.getCell(r, 1).value = asText(item.name);
      ws.getCell(r, 2).value = item.in;
      ws.getCell(r, 2).numFmt = `"Rs "#,##0`;
      ws.getCell(r, 2).font = { color: { argb: "FF059669" } };
      ws.getCell(r, 3).value = item.out;
      ws.getCell(r, 3).numFmt = `"Rs "#,##0`;
      ws.getCell(r, 3).font = { color: { argb: "FFDC2626" } };
      ws.getCell(r, 4).value = item.net;
      ws.getCell(r, 4).numFmt = `"Rs "#,##0;"−Rs "#,##0;"Rs "0`;
      ws.getCell(r, 4).font = { bold: true, color: { argb: item.net >= 0 ? "FF059669" : "FFDC2626" } };
      r += 1;
    }
  }
}

function paintTransactionsSheet(ws, report) {
  const headers = ["Date", "Time", "Kind", "Title", "Category", "Account", "Amount", "Currency", "Note", "Adjustment"];
  ws.columns = [
    { key: "date", width: 12 },
    { key: "time", width: 8 },
    { key: "kind", width: 10 },
    { key: "title", width: 28 },
    { key: "category", width: 16 },
    { key: "account", width: 16 },
    { key: "amount", width: 14 },
    { key: "currency", width: 10 },
    { key: "note", width: 28 },
    { key: "adjustment", width: 12 },
  ];

  styleHeaderRow(ws, 1, headers);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  report.rows.forEach((item, i) => {
    const rowIndex = i + 2;
    const row = ws.getRow(rowIndex);
    const band = i % 2 === 1;
    const tone = item.adjustment ? "FFF59E0B" : item.amount >= 0 ? "FF059669" : "FFDC2626";
    const bg = item.adjustment ? "FFFFFBEB" : band ? "FFF8F7FC" : "FFFFFFFF";

    const values = [
      item.date,
      item.time,
      item.kind,
      asText(item.title),
      asText(item.category),
      asText(item.account),
      item.amount,
      item.currency || "PKR",
      asText(item.note),
      item.adjustment ? "yes" : "no",
    ];
    values.forEach((v, c) => {
      const cell = row.getCell(c + 1);
      cell.value = v;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
      cell.font = { name: "Calibri", size: 11, color: { argb: c === 6 ? tone : "FF1F2937" } };
      cell.alignment = { vertical: "middle", wrapText: c === 3 || c === 8 };
      if (c === 6) {
        cell.numFmt = `"Rs "#,##0;"−Rs "#,##0;"Rs "0`;
        cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: tone } };
      }
    });
  });
}

function styleHeaderRow(ws, rowIndex, headers) {
  const row = ws.getRow(rowIndex);
  headers.forEach((h, i) => {
    const cell = row.getCell(i + 1);
    cell.value = h;
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F33E8" } };
    cell.alignment = { vertical: "middle" };
  });
  row.height = 20;
}

/** Force user content into Excel string cells — never formulas. */
function asText(value) {
  const s = String(value ?? "");
  // ExcelJS treats plain strings as values; leading = is still safe as a string
  // value when assigned directly (not via { formula }). Keep as string always.
  return s;
}

function safeSheetName(name) {
  return String(name || "Sheet")
    .replace(/[\\/?*\[\]:]/g, " ")
    .slice(0, 31) || "Sheet";
}

/* ============================================================
   Date helpers
   ============================================================ */

export function lastDayOfMonth(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${ym}-${pad2(last)}`;
}

function addDays(iso, n) {
  const d = parseDay(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

export const XLSX_CONTENT_TYPE = XLSX_MIME;
