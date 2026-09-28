// Fixtures for js/report-export.js — run with:
//   node --test test/report-export.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReport,
  csvCell,
  defaultRangeForMonth,
  formatLongDate,
  normalizeRange,
  rangeForPreset,
  renderCsvReport,
  renderTextReport,
  reportFilename,
  trustworthyTime,
} from "../js/report-export.js";

const accounts = {
  a1: "JazzCash",
  a2: "Cash",
};

const nameOf = (id) => accounts[id] || "";

function entry(patch) {
  return {
    id: patch.id || "e1",
    kind: "expense",
    title: "Item",
    amount: 100,
    category: "Food",
    status: "paid",
    note: "",
    createdAt: "2026-09-10T08:00:00.000Z",
    paidAt: "2026-09-10T08:00:00.000Z",
    dueDate: null,
    accountId: "a1",
    isAdjustment: false,
    ...patch,
  };
}

test("defaultRangeForMonth: current month is 1st → today", () => {
  assert.deepEqual(
    defaultRangeForMonth("2026-09", "2026-09-28"),
    { from: "2026-09-01", to: "2026-09-28" },
  );
});

test("defaultRangeForMonth: past month is full month", () => {
  assert.deepEqual(
    defaultRangeForMonth("2026-08", "2026-09-28"),
    { from: "2026-08-01", to: "2026-08-31" },
  );
});

test("rangeForPreset covers quick chips", () => {
  assert.deepEqual(rangeForPreset("this_month", { today: "2026-09-28" }), {
    from: "2026-09-01", to: "2026-09-28",
  });
  assert.deepEqual(rangeForPreset("last_7", { today: "2026-09-28" }), {
    from: "2026-09-22", to: "2026-09-28",
  });
  assert.deepEqual(rangeForPreset("last_30", { today: "2026-09-28" }), {
    from: "2026-08-30", to: "2026-09-28",
  });
  assert.deepEqual(rangeForPreset("last_month", { today: "2026-09-28" }), {
    from: "2026-08-01", to: "2026-08-31",
  });
  assert.equal(rangeForPreset("custom", { today: "2026-09-28" }), null);
});

test("normalizeRange swaps reversed dates and clamps future end", () => {
  const swapped = normalizeRange("2026-09-20", "2026-09-10", "2026-09-28");
  assert.equal(swapped.ok, true);
  assert.deepEqual({ from: swapped.from, to: swapped.to }, {
    from: "2026-09-10", to: "2026-09-20",
  });
  const clamped = normalizeRange("2026-09-01", "2026-10-15", "2026-09-28");
  assert.equal(clamped.ok, true);
  assert.equal(clamped.to, "2026-09-28");
});

test("buildReport includes paid income/expense and signed totals", () => {
  const report = buildReport([
    entry({ id: "1", kind: "income", title: "Salary", amount: 50000, category: "Income",
      paidAt: "2026-09-01T05:00:00.000Z", accountId: "a1" }),
    entry({ id: "2", title: "Groceries", amount: 850, paidAt: "2026-09-15T04:12:00.000Z",
      dueDate: "2026-09-15", accountId: "a1" }),
    entry({ id: "3", kind: "transfer", amount: 1000, paidAt: "2026-09-16T10:00:00.000Z" }),
    entry({ id: "4", status: "pending", amount: 200, dueDate: "2026-09-17" }),
  ], { from: "2026-09-01", to: "2026-09-28", accountNameOf: nameOf,
    generatedAt: new Date("2026-09-28T10:00:00") });

  assert.equal(report.transactions, 2);
  assert.equal(report.moneyIn, 50000);
  assert.equal(report.moneyOut, 850);
  assert.equal(report.net, 49150);
  assert.equal(report.daysRecorded, 2);
  assert.equal(report.rows[0].date, "2026-09-15");
  assert.equal(report.rows[0].amount, -850);
  assert.equal(report.rows[1].amount, 50000);
});

test("adjustment toggle excludes starting balance / balance fix", () => {
  const entries = [
    entry({ id: "adj", kind: "income", title: "Starting balance", amount: 1000,
      isAdjustment: true, paidAt: "2026-09-01T10:00:00.000Z" }),
    entry({ id: "real", title: "Tea", amount: 120, paidAt: "2026-09-02T09:00:00.000Z",
      dueDate: "2026-09-02" }),
  ];
  const withAdj = buildReport(entries, {
    from: "2026-09-01", to: "2026-09-28", includeAdjustments: true, accountNameOf: nameOf,
  });
  const without = buildReport(entries, {
    from: "2026-09-01", to: "2026-09-28", includeAdjustments: false, accountNameOf: nameOf,
  });
  assert.equal(withAdj.transactions, 2);
  assert.equal(withAdj.moneyIn, 1000);
  assert.equal(without.transactions, 1);
  assert.equal(without.moneyIn, 0);
  assert.equal(without.moneyOut, 120);
});

test("trustworthyTime blanks synthetic noon and mismatched dates", () => {
  // Paid on a different day than report date → blank
  assert.equal(trustworthyTime({
    paidAt: "2026-09-12T15:30:00.000Z",
  }, "2026-09-10"), "");

  // Exact local noon → blank (synthetic date-picker stamp)
  const noon = new Date(2026, 8, 10, 12, 0, 0);
  assert.equal(trustworthyTime({ paidAt: noon.toISOString() }, "2026-09-10"), "");

  // Real clock time same day → HH:mm
  const real = new Date(2026, 8, 10, 9, 12, 0);
  assert.equal(trustworthyTime({ paidAt: real.toISOString() }, "2026-09-10"), "09:12");
});

test("csvCell escapes quotes and neutralizes formula leads", () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("=cmd"), "'=cmd");
  assert.equal(csvCell("+cmd"), "'+cmd");
  assert.equal(csvCell("-500"), "-500"); // signed amounts stay numeric
  assert.equal(csvCell("@sum"), "'@sum");
});

test("renderCsvReport has BOM, header, and signed amounts", () => {
  const report = buildReport([
    entry({ title: "sabzi", amount: 120, paidAt: "2026-09-22T03:00:00.000Z",
      dueDate: "2026-09-22", note: "mandi" }),
  ], { from: "2026-09-01", to: "2026-09-28", accountNameOf: nameOf });
  const csv = renderCsvReport(report);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("Date,Time,Kind,Title,Category,Account,Amount,Currency,Note,Adjustment"));
  assert.ok(csv.includes("-120"));
  assert.ok(csv.includes("JazzCash"));
});

test("renderTextReport shapes like a WhatsApp report", () => {
  const report = buildReport([
    entry({ id: "i", kind: "income", title: "Salary", amount: 85000, category: "Income",
      paidAt: "2026-09-22T05:00:00.000Z", accountId: "a1" }),
    entry({ id: "e", title: "sabzi", amount: 120, category: "Food",
      paidAt: new Date(2026, 8, 22, 7, 58, 0).toISOString(),
      dueDate: "2026-09-22", accountId: "a2" }),
  ], {
    from: "2026-09-01", to: "2026-09-28", accountNameOf: nameOf,
    generatedAt: new Date(2026, 8, 28),
  });
  const text = renderTextReport(report);
  assert.ok(text.startsWith("Batwa — Expense Report"));
  assert.ok(text.includes("Money in"));
  assert.ok(text.includes("🟢"));
  assert.ok(text.includes("🔴"));
  assert.ok(text.includes("sabzi"));
  assert.ok(text.includes("Total out"));
});

test("reportFilename is deterministic", () => {
  assert.equal(
    reportFilename({ from: "2026-09-01", to: "2026-09-28" }, "csv"),
    "batwa-20260901_to_20260928.csv",
  );
});

test("empty range still renders text", () => {
  const report = buildReport([], {
    from: "2026-09-01", to: "2026-09-28", accountNameOf: nameOf,
  });
  assert.equal(report.transactions, 0);
  const text = renderTextReport(report);
  assert.ok(text.includes("No paid income or expenses"));
});

test("formatLongDate", () => {
  assert.equal(formatLongDate("2026-09-28"), "Sep 28, 2026");
});
