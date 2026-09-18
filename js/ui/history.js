// History: its own tab. Month browser + filters + full transaction list.
// Filter changes re-render ONLY the list (with a brief loader), never the page.

import { $, el, esc, anim, buzz } from "../util/dom.js";
import { fmtCompact, monthLabel, thisMonth, shiftMonth, dayLabel, daysUntil, entryDate } from "../util/format.js";
import { state, entriesForMonth, partialOf } from "../ledger.js";
import { accountName } from "./accounts.js";
import { icon, catIcon } from "./icons.js";
import { addExpenseSheet, addMoneySheet, transferDetailSheet, sharedDetailSheet } from "./modals.js";
import {
  hasSpaces, getSpace, colorHex, memberNameIn, rowSettlementStatus, nudgeSettlement,
  settlementIdOf,
} from "../spaces.js";

let currentMonth = thisMonth();
let filters = { kind: "all", category: "all", status: "all", account: "all" };

export function renderHistory(view) {
  pruneFilters();
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
  // Shared and Settlements only exist once this phone holds a space — with no
  // spaces, History looks exactly as it always did (plan §0).
  const kinds = [["all", "All"], ["expense", "Expenses"], ["income", "Income"], ["transfer", "Transfers"]];
  if (hasSpaces()) kinds.push(["shared", "Shared"], ["settlement", "Settlements"]);
  const groups = [
    { key: "kind", opts: kinds },
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

/**
 * A category the filter is pinned to can be renamed or deleted from the inline
 * editor while `filters` survives the re-render — drop it rather than showing
 * an empty list for a name that no longer exists.
 */
function pruneFilters() {
  if (filters.category !== "all" && !state.categories.includes(filters.category)) {
    filters.category = "all";
  }
}

function applyFilters() {
  pruneFilters();
  let list = entriesForMonth(currentMonth);
  // "Shared" is not a kind but a provenance: every row that came out of a
  // space, whatever shape it took here (my share, what I fronted, a settlement).
  if (filters.kind === "shared") list = list.filter((e) => !!e.spaceId);
  else if (filters.kind !== "all") list = list.filter((e) => e.kind === filters.kind);
  if (filters.status !== "all") list = list.filter((e) => e.status === filters.status);
  if (filters.category !== "all") list = list.filter((e) => e.category === filters.category);
  if (filters.account !== "all") {
    list = list.filter((e) => e.accountId === filters.account || e.fromAccountId === filters.account || e.toAccountId === filters.account);
  }
  return list.sort((a, b) => (dateKey(a) < dateKey(b) ? 1 : -1)); // newest first
}

/** The one date a row belongs to — the same key entriesForMonth() buckets by.
 * One shared rule now (util/format.js entryDate) so History, the ledger and
 * insights can never drift apart. */
const dateKey = entryDate;

/** Amount chips for one day: out (ink), in (green), transfers only when nothing else moved. */
function dayTotal(rows) {
  let out = 0, inn = 0, tr = 0;
  for (const e of rows) {
    const a = Number(e.amount) || 0;
    switch (e.kind) {
      case "expense": out += a; break;
      case "income": inn += a; break;
      case "transfer": tr += a; break;
      // Money I fronted left the account that day exactly like a payment did.
      case "lent": out += a; break;
      // A settlement is real money moving one way or the other.
      // A write-off moved no money on the day it was recorded.
      case "settlement": if (e.writeoff) break; if (e.direction === "in") inn += a; else out += a; break;
      default: break; // unknown kind: counted in no chip
    }
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
        if (!row) return; // unknown kind: nothing this build knows how to draw
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

/** Row dispatch by kind. Unknown kinds draw nothing rather than a wrong row. */
function historyRow(e) {
  switch (e.kind) {
    case "transfer": return transferHistoryRow(e);
    case "income": return moneyHistoryRow(e, true);
    case "expense": return moneyHistoryRow(e, false);
    case "lent": return lentHistoryRow(e);
    case "settlement": return settlementHistoryRow(e);
    default: return null;
  }
}

/** The space's colour as a 7px dot, or "" for a row that came from nowhere. */
function spaceDot(e) {
  const space = e.spaceId ? getSpace(e.spaceId) : null;
  if (!space) return "";
  return `<i class="hist-space-dot" style="background:${colorHex(space.color)}" title="${esc(space.name)}"></i>`;
}
/**
 * The space a row came from. A space I have LEFT has no bundle any more, so
 * the name was written onto the row itself on the way out (plan §8) and the
 * label says so rather than going blank.
 */
const spaceName = (e) => {
  if (!e.spaceId) return null;
  const live = getSpace(e.spaceId);
  if (live) return live.name;
  return e.spaceLeft ? `Left ${e.spaceLeft}` : null;
};

/** "Lent · Home · Rs 2,000 (Rs 1,000 back)" */
function lentHistoryRow(e) {
  const back = Number(e.repaid) || 0;
  const row = el("div", { class: "hist-row" });
  row.innerHTML = `
    <span class="hist-ico" style="background:var(--c-warn-soft, var(--c-violet-soft));color:var(--c-warn)">${icon("user-plus", 18)}</span>
    <span class="grow">
      <span class="strong small truncate" style="display:block">${spaceDot(e)}Lent · ${esc(e.title || "Shared")}</span>
      <span class="xsmall muted">${esc(spaceName(e) || "Shared")}
        ${back ? `· ${fmtCompact(back)} back` : ""}
        ${e.accountId && accountName(e.accountId) ? `· ${esc(accountName(e.accountId))}` : ""}</span>
    </span>
    <span class="hist-amt num">−${fmtCompact(e.amount)}</span>`;
  row.addEventListener("click", () => { buzz(8); sharedDetailSheet(e); });
  row.style.cursor = "pointer";
  return row;
}

/**
 * The marker a settlement carries until the other side answers: pending while
 * it is in the air, confirmed when they said it landed, unconfirmed when they
 * said it never did. An unconfirmed row keeps its money — I did send it — and
 * offers the only useful reply, which is to ask again (plan §6).
 */
const SETTLE_MARK = {
  pending: '<b style="color:var(--c-warn)">pending</b>',
  confirmed: '<b style="color:var(--c-pos)">confirmed</b>',
  unconfirmed: '<b style="color:var(--c-neg)">unconfirmed</b>',
};

/** "Sent to Faraz · Home" / "From Faraz · Home" */
function settlementHistoryRow(e) {
  const inn = e.direction === "in";
  const who = e.spaceId && e.counterpart ? memberNameIn(e.spaceId, e.counterpart) : null;
  const title = e.writeoff
    ? `Written off${who ? ` · ${who}` : ""}`
    : who ? `${inn ? "From" : "Sent to"} ${who}` : (e.title || (inn ? "Money received" : "Money sent"));
  const st = rowSettlementStatus(e);
  const row = el("div", { class: `hist-row ${st ? `is-${st}` : ""}` });
  row.innerHTML = `
    <span class="hist-ico" style="background:var(--c-aqua-soft);color:var(--c-aqua)">${icon(e.writeoff ? "scale" : "swap", 18)}</span>
    <span class="grow">
      <span class="strong small truncate" style="display:block">${spaceDot(e)}${esc(title)}${spaceName(e) ? ` · ${esc(spaceName(e))}` : ""}</span>
      <span class="xsmall muted">${e.writeoff ? "written off" : "settlement"}
        ${st ? `· ${SETTLE_MARK[st]}` : ""}
        ${e.accountId && accountName(e.accountId) ? `· ${esc(accountName(e.accountId))}` : ""}</span>
    </span>
    <span class="hist-amt num ${inn && !e.writeoff ? "in" : ""}">${e.writeoff ? "" : inn ? "+" : "−"}${fmtCompact(e.amount)}</span>`;
  if (st === "unconfirmed") row.append(nudgeButton(e));
  row.addEventListener("click", () => { buzz(8); sharedDetailSheet(e); });
  row.style.cursor = "pointer";
  return row;
}

/** "Nudge again", on the row itself — the action belongs where the problem is. */
function nudgeButton(e) {
  const btn = el("button", { class: "chip-btn hist-nudge", type: "button" }, "Nudge again");
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    buzz(10);
    nudgeSettlement(e.spaceId, settlementIdOf(e));
    btn.disabled = true;
    btn.textContent = "Nudged";
  });
  return btn;
}

/** Expense and income share one row; `inn` picks the colour, icon and sign. */
function moneyHistoryRow(e, inn) {
  // A share a settlement of mine paid off carries that settlement's fate: if
  // the other side says it never arrived, this row says so too (§6).
  const st = e.settledBy ? rowSettlementStatus(e) : null;
  const part = partialOf(e);
  const row = el("div", { class: `hist-row ${st ? `is-${st}` : ""}` });
  row.innerHTML = `
    <span class="hist-ico" style="background:${inn ? "var(--c-pos-soft)" : "var(--c-violet-soft)"};color:${inn ? "var(--c-pos)" : "var(--c-violet)"}">
      ${inn ? icon("banknote", 18) : catIcon(e.category, 18)}
    </span>
    <span class="grow">
      <span class="strong small truncate" style="display:block">${spaceDot(e)}${esc(e.title)}</span>
      <span class="xsmall muted">${esc(e.category)}
        ${e.spaceId ? `· your share · ${esc(spaceName(e) || "shared")}` : ""}
        ${e.accountId && accountName(e.accountId) ? `· ${esc(accountName(e.accountId))}` : ""}
        ${e.isAdjustment ? `· <b style="color:var(--c-violet)">${icon("scale", 10)} adjustment</b>` : ""}
        ${part > 0 ? `· <b style="color:var(--c-warn)">${fmtCompact(part)} of ${fmtCompact(e.amount)} paid</b>`
          : e.status === "pending" ? '· <b style="color:var(--c-warn)">pending</b>' : ""}
        ${st && st !== "confirmed" ? `· ${SETTLE_MARK[st]}` : ""}
        ${e.recurrence !== "one-time" ? `· ${icon("repeat", 10)} ${e.recurrence}` : ""}</span>
    </span>
    <span class="hist-amt num ${inn ? "in" : ""}">${inn ? "+" : "−"}${fmtCompact(e.amount)}</span>
  `;
  if (st === "unconfirmed") row.append(nudgeButton(e));
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
