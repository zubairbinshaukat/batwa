// History: its own tab. Month browser + filters + full transaction list.
// Filter changes re-render ONLY the list (with a brief loader), never the page.

import { $, el, esc, anim, buzz } from "../util/dom.js";
import { fmtCompact, monthLabel, thisMonth, shiftMonth, shortDate } from "../util/format.js";
import { state, entriesForMonth } from "../ledger.js";
import { accountName } from "./accounts.js";
import { icon, catIcon } from "./icons.js";
import { addExpenseSheet, addMoneySheet } from "./modals.js";

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
    { key: "kind", opts: [["all", "All"], ["expense", "Expenses"], ["income", "Income"]] },
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
  if (filters.account !== "all") list = list.filter((e) => e.accountId === filters.account);
  return list.sort((a, b) => {
    const da = a.kind === "income" ? (a.paidAt || a.createdAt) : (a.dueDate || a.createdAt);
    const db_ = b.kind === "income" ? (b.paidAt || b.createdAt) : (b.dueDate || b.createdAt);
    return da < db_ ? 1 : -1; // newest first
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
    for (const e of list) root.append(historyRow(e));
    anim([...root.children], { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.28, stagger: 0.02, ease: "power2.out" });
  };

  if (!loading) return draw();

  root.innerHTML = `<div class="list-loader">${icon("refresh", 20)}</div>`;
  // one frame of loader so the tap registers visually, then swap in results
  setTimeout(draw, 180);
}

function historyRow(e) {
  const inn = e.kind === "income";
  const dateIso = (inn ? (e.paidAt || e.createdAt) : (e.dueDate || e.createdAt)).slice(0, 10);
  const row = el("div", { class: "hist-row" });
  row.innerHTML = `
    <span class="hist-ico" style="background:${inn ? "var(--c-pos-soft)" : "var(--c-violet-soft)"};color:${inn ? "var(--c-pos)" : "var(--c-violet)"}">
      ${inn ? icon("banknote", 18) : catIcon(e.category, 18)}
    </span>
    <span class="grow">
      <span class="strong small truncate" style="display:block">${esc(e.title)}</span>
      <span class="xsmall muted">${shortDate(dateIso)} · ${esc(e.category)}
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
