// History: its own tab. Month browser + filters + full transaction list.
// Filter changes re-render ONLY the list (with a brief loader), never the page.

import { $, el, esc, anim, buzz } from "../util/dom.js";
import { fmtCompact, monthLabel, thisMonth, shiftMonth, dayLabel, daysUntil } from "../util/format.js";
import { state, entriesForMonth } from "../ledger.js";
import { accountName } from "./accounts.js";
import { icon, catIcon } from "./icons.js";
import { addExpenseSheet, addMoneySheet, transferDetailSheet } from "./modals.js";

let currentMonth = thisMonth();
let filters = { kind: "all", category: "all", status: "all", account: "all" };

export function renderHistory(view) {
  const isNow = currentMonth === thisMonth();

  view.innerHTML = `
    <div class="month-nav">
      <button class="icon-btn" id="h-prev" aria-label="Previous month">${icon("chevron-left", 18)}</button>
      <div class="month-label">${monthLabel(currentMonth)}</div>
      <button class="icon-btn" id="h-next" aria-label="Next month" ${isNow ? "disabled style='opacity:.35'" : ""}>${icon("chevron-right", 18)}</button>
    </div>
    <div id="h-filters"></div>
    <div class="spread" style="margin:var(--s-4) 0 var(--s-2)">
      <h2>Transactions</h2>
      <span class="count" id="h-count"></span>
    </div>
    <div class="card" id="h-list"></div>
  `;

  $("#h-prev", view).addEventListener("click", () => {
    currentMonth = shiftMonth(currentMonth, -1);
    renderHistory(view);
  });
  $("#h-next", view).addEventListener("click", () => {
    if (currentMonth < thisMonth()) {
      currentMonth = shiftMonth(currentMonth, 1);
      renderHistory(view);
    }
  });

  renderFilters($("#h-filters", view), view);
  paintList(view);

  anim(view.children, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, stagger: 0.05, ease: "power2.out" });
}

function renderFilters(root, view) {
  const groups = [
    { key: "kind", opts: [["all", "All"], ["expense", "Expenses"], ["income", "Income"], ["transfer", "Transfers"]] },
    { key: "status", opts: [["all", "Any status"], ["paid", "Paid"], ["pending", "Pending"]] },
  ];
  if (state.accounts.length) {
    groups.push({ key: "account", opts: [["all", "All accounts"], ...state.accounts.map((a) => [a.id, a.name])] });
  }
  groups.push({ key: "category", opts: [["all", "All categories"], ...state.categories.map((c) => [c, c])] });

  for (const g of groups) {
    const row = el("div", { class: "filter-row" });
    for (const [val, label] of g.opts) {
      const chip = el("button", {
        class: `filter-chip ${filters[g.key] === val ? "is-active" : ""}`,
        onclick: () => {
          if (filters[g.key] === val) return;
          filters[g.key] = val;
          buzz(6);
          [...row.children].forEach((c) => c.classList.remove("is-active"));
          chip.classList.add("is-active");
          paintList(view, { loading: true });   // list only — page stays put
        },
      }, label);
      row.append(chip);
    }
    root.append(row);
  }
}

function applyFilters() {
  let list = entriesForMonth(currentMonth);
  if (filters.kind !== "all") list = list.filter((e) => e.kind === filters.kind);
  if (filters.status !== "all") list = list.filter((e) => e.status === filters.status);
  if (filters.category !== "all") list = list.filter((e) => e.category === filters.category);
  if (filters.account !== "all") {
    list = list.filter((e) => e.accountId === filters.account || e.fromAccountId === filters.account || e.toAccountId === filters.account);
  }
  return list.sort((a, b) => (dateKey(a) < dateKey(b) ? 1 : -1)); // newest first
}

/** The one date a row belongs to — the same key entriesForMonth() buckets by. */
function dateKey(e) {
  const d = e.kind === "transfer" ? (e.paidAt || e.createdAt)
    : e.kind === "income" ? (e.paidAt || e.dueDate || e.createdAt)
    : (e.dueDate || e.paidAt || e.createdAt);
  return String(d).slice(0, 10);
}

/** Amount chips for one day: out (ink), in (green), transfers only when nothing else moved. */
function dayTotal(rows) {
  let out = 0, inn = 0, tr = 0;
  for (const e of rows) {
    const a = Number(e.amount) || 0;
    if (e.kind === "expense") out += a;
    else if (e.kind === "income") inn += a;
    else if (e.kind === "transfer") tr += a;
  }
  const chips = [];
  if (out > 0) chips.push(`<span class="sum out num">−${fmtCompact(out)}</span>`);
  if (inn > 0) chips.push(`<span class="sum in num">+${fmtCompact(inn)}</span>`);
  if (!chips.length && tr > 0) chips.push(`<span class="sum tr num">${icon("swap", 11)} ${fmtCompact(tr)}</span>`);
  if (!chips.length) chips.push(`<span class="sum out num">−</span>`);
  return chips.join("");
}

/* "Thu 17 Sep" -> { wd, num, mon } */
function dayParts(iso) {
  const [wd, num, mon] = dayLabel(iso).split(" ");
  return { wd, num, mon };
}

function dayDivider(day, rows, first) {
  const { wd, num, mon } = dayParts(day);
  const d = daysUntil(day);
  const rel = d === 0 ? "Today" : d === -1 ? "Yesterday" : d === 1 ? "Tomorrow" : "";
  const longDay = new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long" });
  return el("div", {
    class: `hist-day ${first ? "is-first" : ""} ${d === 0 ? "is-today" : ""}`,
    html: `
      <span class="hist-day-date"><b class="num">${num}</b><small>${wd}</small></span>
      <span class="hist-day-name">${rel || longDay}<span> · ${num} ${mon}</span></span>
      <span class="hist-day-sum">${dayTotal(rows)}</span>`,
  });
}

function paintList(view, { loading = false } = {}) {
  const root = $("#h-list", view);
  const count = $("#h-count", view);
  if (!root) return;

  const draw = () => {
    const list = applyFilters();
    count.textContent = list.length || "";
    root.innerHTML = "";
    if (!list.length) {
      root.innerHTML = `<div class="empty" style="border:none;background:none;padding:28px">
        <div class="empty-ico">${icon("inbox", 26)}</div>
        <p>Nothing matches these filters.</p></div>`;
      return;
    }
    // group the continuous list into days, each under its own divider
    const groups = [];
    for (const e of list) {
      const day = dateKey(e);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.rows.push(e);
      else groups.push({ day, rows: [e] });
    }
    groups.forEach((g, i) => {
      root.append(dayDivider(g.day, g.rows, i === 0));
      g.rows.forEach((e, j) => {
        const row = historyRow(e);
        if (j === 0) row.classList.add("is-day-first");
        root.append(row);
      });
    });
    anim([...root.children], { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.28, stagger: 0.02, ease: "power2.out" });
  };

  if (!loading) return draw();

  root.innerHTML = `<div class="list-loader">${icon("refresh", 20)}</div>`;
  // one frame of loader so the tap registers visually, then swap in results
  setTimeout(draw, 180);
}

function historyRow(e) {
  if (e.kind === "transfer") return transferHistoryRow(e);

  const inn = e.kind === "income";
  const row = el("div", { class: "hist-row" });
  row.innerHTML = `
    <span class="hist-ico" style="background:${inn ? "var(--c-pos-soft)" : "var(--c-violet-soft)"};color:${inn ? "var(--c-pos)" : "var(--c-violet)"}">
      ${inn ? icon("banknote", 18) : catIcon(e.category, 18)}
    </span>
    <span class="grow">
      <span class="strong small truncate" style="display:block">${esc(e.title)}</span>
      <span class="xsmall muted">${esc(e.category)}
        ${e.accountId && accountName(e.accountId) ? `· ${esc(accountName(e.accountId))}` : ""}
        ${e.isAdjustment ? `· <b style="color:var(--c-violet)">${icon("scale", 10)} adjustment</b>` : ""}
        ${e.status === "pending" ? '· <b style="color:var(--c-warn)">pending</b>' : ""}
        ${e.recurrence !== "one-time" ? `· ${icon("repeat", 10)} ${e.recurrence}` : ""}</span>
    </span>
    <span class="hist-amt num ${inn ? "in" : ""}">${inn ? "+" : "−"}${fmtCompact(e.amount)}</span>
  `;
  row.addEventListener("click", () => {
    buzz(8);
    inn ? addMoneySheet(e) : addExpenseSheet(e);
  });
  row.style.cursor = "pointer";
  return row;
}

function transferHistoryRow(e) {
  const from = accountName(e.fromAccountId) || "Removed";
  const to = accountName(e.toAccountId) || "Removed";
  const row = el("div", { class: "hist-row" });
  row.innerHTML = `
    <span class="hist-ico" style="background:var(--c-aqua-soft);color:var(--c-aqua)">${icon("swap", 18)}</span>
    <span class="grow">
      <span class="strong small truncate" style="display:block">Transfer</span>
      <span class="xsmall muted">${esc(from)} → ${esc(to)}</span>
    </span>
    <span class="hist-amt num">${fmtCompact(e.amount)}</span>
  `;
  row.addEventListener("click", () => { buzz(8); transferDetailSheet(e); });
  row.style.cursor = "pointer";
  return row;
}
