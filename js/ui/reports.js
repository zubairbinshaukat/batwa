// Reports: month browser, summary tiles, spending breakdown, patterns, charts,
// insights. History has its own tab.
// The facts come from js/insights.js (pure); this file only turns them into
// sentences and pixels.

import { $, el, esc, anim, buzz, segmented } from "../util/dom.js";
import { fmtMoney, fmtCompact, fmtNum, monthLabel, thisMonth, shiftMonth, shortDate } from "../util/format.js";
import { state, monthSummary, limitStatus, sharedTotals } from "../ledger.js";
import { hasSpaces } from "../spaces.js";
import { analyzeMonth, spendDate } from "../insights.js";
import { donut, trendBars, splitBar, weekdayBars, phaseBar, animateCharts, CHART_COLORS } from "./charts.js";
import { icon, catIcon } from "./icons.js";
import { accountName } from "./accounts.js";
import { addExpenseSheet } from "./modals.js";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TOP_TITLES = 5;

let currentMonth = thisMonth();
let breakdownTab = "category";   // survives month navigation
let titlesExpanded = false;      // resets on month change

export function renderReports(view) {
  const ym = currentMonth;
  const sum = monthSummary(ym);
  const prev = monthSummary(shiftMonth(ym, -1));
  const analysis = analyzeMonth(state.entries, ym);
  const insights = buildInsights(analysis, sum, prev);
  const isNow = ym === thisMonth();

  view.innerHTML = `
    <div class="month-nav">
      <button class="icon-btn" id="m-prev" aria-label="Previous month">${icon("chevron-left", 18)}</button>
      <div class="month-label">${monthLabel(ym)}</div>
      <button class="icon-btn" id="m-next" aria-label="Next month" ${isNow ? "disabled style='opacity:.35'" : ""}>${icon("chevron-right", 18)}</button>
    </div>

    <div class="reports-grid">
      <div class="rg-col">
        <div class="tiles">
          <div class="tile"><div class="tile-label">Money in</div>
            <div class="tile-value num pos">${fmtCompact(sum.income)}</div>
            ${delta(sum.income, prev.income, "vs last month")}</div>
          <div class="tile"><div class="tile-label">Money out</div>
            <div class="tile-value num">${fmtCompact(sum.spent)}</div>
            ${delta(sum.spent, prev.spent, "vs last month", true)}</div>
          <div class="tile" style="grid-column:1/-1"><div class="tile-label">Net</div>
            <div class="tile-value num ${sum.net >= 0 ? "pos" : "neg"}">${sum.net >= 0 ? "+" : ""}${fmtCompact(sum.net)}</div></div>
        </div>

        <div id="shared-slot"></div>

        <div id="insights" class="stack" style="margin-top:16px"></div>

        <div class="section-head"><h2>Spending breakdown</h2></div>
        <div class="card chart-card" id="breakdown">
          <div id="bd-tabs" class="bd-tabs"></div>
          <div id="bd-panel" role="tabpanel"></div>
        </div>
      </div>

      <div class="rg-col">
        <div class="section-head"><h2>Spending patterns</h2></div>
        <div class="card chart-card" id="patterns"></div>

        <div id="watch"></div>

        <div class="section-head"><h2>6-month trend</h2></div>
        <div class="card chart-card" id="trend-chart"></div>

        <div class="section-head"><h2>Fixed vs one-off</h2></div>
        <div class="card chart-card" id="split-chart"></div>
      </div>
    </div>
  `;

  $("#m-prev", view).addEventListener("click", () => { goMonth(view, -1); });
  $("#m-next", view).addEventListener("click", () => {
    if (currentMonth < thisMonth()) goMonth(view, 1);
  });

  renderShared($("#shared-slot", view), ym);
  renderInsights($("#insights", view), insights);
  renderBreakdown($("#breakdown", view), sum, analysis);
  renderPatterns($("#patterns", view), analysis, insights);
  renderWatch($("#watch", view), insights);
  renderTrend($("#trend-chart", view), ym);
  renderSplit($("#split-chart", view), sum);

  anim([...view.querySelectorAll(".month-nav, .rg-col > *")],
    { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, stagger: 0.05, ease: "power2.out" });
  animateCharts(view);
}

function goMonth(view, step) {
  currentMonth = shiftMonth(currentMonth, step);
  titlesExpanded = false; // a new month starts collapsed; the tab choice stays
  renderReports(view);
}

function delta(cur, prevV, label, inverse = false) {
  if (!prevV) return `<div class="tile-delta" style="color:var(--c-faint)">— ${label}</div>`;
  const pct = Math.round(((cur - prevV) / prevV) * 100);
  if (!pct) return `<div class="tile-delta" style="color:var(--c-faint)">±0% ${label}</div>`;
  const good = inverse ? pct < 0 : pct > 0;
  return `<div class="tile-delta ${good ? "pos" : "neg"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% ${label}</div>`;
}

function emptyCard(text, ico = "sprout") {
  return `<div class="empty" style="border:none;background:none;padding:24px"><div class="empty-ico">${icon(ico, 26)}</div><p>${text}</p></div>`;
}

/* ============================================================
   Insights: facts -> sentences, each behind a confidence gate
   ============================================================ */

/**
 * One list for both places: the top `#insights` block takes the best two
 * good/info lines, the "Worth watching" card takes the best three cautions.
 * Because the tones are disjoint, no line can show up twice.
 */
function buildInsights(a, sum, prev) {
  const out = [];
  const add = (id, tone, weight, html, extra = {}) => out.push({ id, tone, weight, html, ...extra });
  const pct = (v) => Math.round(v * 100);
  const lastMonth = monthLabel(shiftMonth(a.ym, -1)).split(" ")[0];
  const has = (id) => out.some((i) => i.id === id);

  // --- the three that were here before ---
  const cats = Object.entries(sum.byCat).sort((x, y) => y[1] - x[1]);
  if (cats.length) {
    const [top, amt] = cats[0];
    add("top-category", "info", 50,
      `${catIcon(top, 13)} <b>${esc(top)}</b> was your biggest category this month at <b>${fmtMoney(amt)}</b>.`);
  }
  if (prev.spent > 0 && sum.spent > 0) {
    const diff = sum.spent - prev.spent;
    if (Math.abs(diff) > prev.spent * 0.1) {
      add("vs-last-month", diff < 0 ? "good" : "info", 60, diff < 0
        ? `${icon("trend-down", 13)} You spent <b>${fmtMoney(-diff)}</b> less than last month. Keep it up.`
        : `${icon("trend-up", 13)} Spending is up <b>${fmtMoney(diff)}</b> vs last month.`);
    }
  }
  if (sum.recurringOut > 0 && sum.spent > 0) {
    const p = pct(sum.recurringOut / sum.spent);
    if (p >= 40) {
      add("recurring-baseline", "info", 40,
        `${icon("repeat", 13)} <b>${p}%</b> of this month's spending is recurring — your fixed baseline is <b>${fmtMoney(sum.recurringOut)}</b>.`);
    }
  }

  // --- what a few things decide ---
  if (a.concentration && a.titles.length >= 5 && a.concentration.share >= 0.5) {
    const names = a.concentration.titles.map((t) => t.title);
    add("concentration", "caution", 90,
      `Three things are <b>${pct(a.concentration.share)}%</b> of your month: ${names.map((n) => `<b>${esc(n)}</b>`).join(", ")}. These decide the month, so plan them first.`,
      { pills: names });
  }
  if (!has("concentration") && a.largest && a.largest.share >= 0.25 && a.count >= 3) {
    const e = a.largest.entry;
    add("largest-single", "caution", 80,
      `One payment, <b>${esc(e.title || "Untitled")}, ${fmtMoney(e.amount)}</b>, was <b>${pct(a.largest.share)}%</b> of everything you spent.`);
  }

  // --- small and often ---
  const habit = a.habits[0];
  if (habit && habit.count >= 4 && habit.total >= 0.05 * a.spent) {
    add("habit", "caution", 70,
      `<b>${esc(habit.title)}</b>, <b>${habit.count} times</b>. Small each time, <b>${fmtMoney(habit.total)}</b> together.`);
  }

  // --- the shape of the week ---
  const w = a.weekday;
  if (a.count >= 8 && w.daysElapsed[5] >= 2 && w.daysElapsed[6] >= 2 && w.ratio != null && w.ratio >= 1.25) {
    add("weekend", "caution", 75,
      `Weekends cost you <b>${pct(w.ratio - 1)}%</b> more per day than weekdays.`);
  }
  if (!has("weekend") && a.count >= 8 && w.topIndex >= 0) {
    const mean = w.perDay.reduce((s, v) => s + v, 0) / 7;
    if (mean > 0 && w.perDay[w.topIndex] >= 1.5 * mean) {
      add("weekday-peak", "info", 30,
        `<b>${WEEKDAYS[w.topIndex]}s</b> are your most expensive day, about <b>${fmtMoney(w.perDay[w.topIndex])}</b> each.`);
    }
  }

  // --- the shape of the month ---
  if (a.daysElapsed >= 20 && a.phase.shares.early >= 0.5) {
    add("front-loaded", "info", 35,
      `More than half your month (<b>${pct(a.phase.shares.early)}%</b>) goes in the first 10 days.`);
  }
  if (a.daysElapsed >= 25 && a.phase.shares.late >= 0.45) {
    add("back-loaded", "caution", 45,
      `<b>${pct(a.phase.shares.late)}%</b> of your spending landed in the last 10 days. The month got expensive at the end.`);
  }

  // --- where this month is heading ---
  if (a.projection && a.daysElapsed >= 5 && a.projection.prevSpent > 0) {
    const over = a.projection.projected > a.projection.prevSpent * 1.1;
    add("pace", over ? "caution" : "info", over ? 65 : 25,
      `At this pace you'll end at about <b>${fmtMoney(a.projection.projected)}</b>, vs <b>${fmtMoney(a.projection.prevSpent)}</b> last month.`);
  }

  // --- one loud day ---
  const peak = a.daily.peak;
  if (peak && a.daily.spendDays >= 3 && peak.total >= 2 * a.daily.avg && peak.total >= 0.15 * a.spent) {
    const n = peak.entries.length;
    add("peak-day", "info", 20,
      `<b>${shortDate(peak.date)}</b> was your priciest day: <b>${fmtMoney(peak.total)}</b> across ${n} payment${n === 1 ? "" : "s"}.`);
  }

  // --- what changed since last month ---
  const riser = a.deltas.risers[0];
  if (riser) {
    add("riser", "caution", 55,
      `<b>${esc(riser.title)}</b> is up <b>${fmtMoney(riser.diff)}</b> (+${Math.round(riser.pct)}%) vs ${esc(lastMonth)}.`);
  }
  const newcomer = a.deltas.newcomers.find((t) => t.total >= 0.1 * a.spent);
  if (newcomer) {
    add("newcomer", "info", 15,
      `<b>${esc(newcomer.title)}</b> is new this month: <b>${fmtMoney(newcomer.total)}</b> you didn't have in the last few months.`);
  }

  // --- money that couldn't be traced ---
  if (a.adjustments.total > 0 && a.adjustments.share >= 0.15) {
    add("adjustments", "caution", 85,
      `<b>${fmtMoney(a.adjustments.total)}</b> of this month is balance fixes, money you couldn't trace. Logging as you go keeps this number small.`);
  }

  // --- category limits: the plan the user set for themselves ---
  const lims = limitStatus(a.ym);
  for (const l of lims) {
    if (l.over > 0) {
      add("limit-over", "caution", 95,
        `<b>${esc(l.category)}</b> is <b>${fmtMoney(l.over)} over</b> its ${fmtMoney(l.limit)} limit.`,
        { pills: [l.category] });
    } else if (l.ratio >= 0.8 && l.daysLeft >= 3) {
      add("limit-near", "caution", 70,
        `<b>${esc(l.category)}</b> has used <b>${pct(l.ratio)}%</b> of its limit with ${l.daysLeft} days left.`,
        { pills: [l.category] });
    }
  }
  if (lims.length && lims.every((l) => l.ratio < 0.8)) {
    add("limit-ok", "good", 15,
      `Every category you set a limit on is still under <b>80%</b> of it.`);
  }

  // --- the quiet days ---
  if (a.daysElapsed >= 10 && a.daily.noSpendDays >= 0.3 * a.daysElapsed) {
    add("no-spend", "good", 20, `<b>${a.daily.noSpendDays} no-spend days</b> this month. Nice.`);
  }

  return out;
}

const byWeight = (a, b) => b.weight - a.weight;
const insightById = (list, id) => list.find((i) => i.id === id) || null;

/**
 * The "Shared" card (plan §5.4): three figures that exist only because of
 * spaces, kept well away from the spending breakdown — lent money and
 * settlements are not spending and must never move a category total.
 * Nothing at all when this phone holds no spaces.
 */
function renderShared(root, ym) {
  if (!root || !hasSpaces()) return;
  const t = sharedTotals(ym);
  if (!t.lentOut && !t.owed && !t.settled) return;
  const card = el("div", { class: "card shared-report" });
  const rows = [
    ["Lent out", t.lentOut, "is-out"],
    ["You owe", t.owed, "is-owe"],
    ["Settled this month", t.settled, ""],
  ];
  const grid = el("div", { class: "shared-report-grid" });
  for (const [label, value, cls] of rows) {
    grid.append(el("div", { class: `shared-stat ${cls}` },
      el("span", { class: "shared-stat-label" }, label),
      el("span", { class: "shared-stat-value num" }, fmtMoney(value))));
  }
  card.append(grid);
  root.append(el("div", { class: "section-head" }, el("h2", {}, "Shared")), card);
}

function renderInsights(root, insights) {
  const top = insights.filter((i) => i.tone !== "caution").sort(byWeight).slice(0, 2);
  for (const ins of top) {
    root.append(el("div", { class: "insight", html: `<span class="spark">${icon("sparkles", 16)}</span><span>${ins.html}</span>` }));
  }
}

function renderWatch(root, insights) {
  // weekend / back-loaded / pace already read as captions in the patterns card — no second airing here
  const SHOWN_IN_PATTERNS = new Set(["weekend", "back-loaded", "pace"]);
  const lines = insights.filter((i) => i.tone === "caution" && !SHOWN_IN_PATTERNS.has(i.id)).sort(byWeight).slice(0, 3);
  if (!lines.length) return; // nothing worth the user's attention: say nothing

  const card = el("div", { class: "card watch-card" });
  card.append(el("div", { class: "watch-head", html: `${icon("alert", 15)}<span>Worth watching</span>` }));
  for (const ins of lines) {
    const pills = ins.pills?.length
      ? `<span class="watch-pills">${ins.pills.map((p) => `<span class="badge badge-cat">${esc(p)}</span>`).join("")}</span>`
      : "";
    card.append(el("div", { class: "watch-line", html: `<span>${ins.html}${pills}</span>` }));
  }
  root.append(card);
}

/* ============================================================
   Spending breakdown: Category / Title
   ============================================================ */

function renderBreakdown(root, sum, analysis) {
  const tabs = $("#bd-tabs", root);
  const panel = $("#bd-panel", root);

  const paint = (animate) => {
    panel.replaceChildren();
    if (breakdownTab === "title") renderTitlePanel(panel, analysis);
    else renderCatPanel(panel, sum);
    if (animate) {
      anim(panel, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.22, ease: "power2.out" });
      animateCharts(panel);
    }
  };

  tabs.append(segmented(
    [{ value: "category", label: "Category" }, { value: "title", label: "Title" }],
    breakdownTab,
    (v) => { breakdownTab = v; paint(true); },   // panel only — the page stays put
  ));
  paint(false);
}

/** Second line under a category row: how the month is tracking against its cap. */
function limitLine(l) {
  const tone = l.over > 0 ? "is-over" : l.ratio >= 0.8 ? "is-warn" : "is-ok";
  const width = Math.round(Math.min(1, l.ratio) * 100);
  const text = l.over > 0
    ? `${fmtMoney(l.over)} over`
    : `${fmtMoney(l.spent)} of ${fmtNum(l.limit)}`;
  const left = l.daysLeft > 0 ? ` · ${l.daysLeft} day${l.daysLeft === 1 ? "" : "s"} left` : "";
  return el("div", {
    class: "cat-limit",
    html: `<span class="limit-track"><span class="limit-fill ${tone}" style="width:${width}%"></span></span>
      <span class="cat-limit-txt ${tone}">${text}${left}</span>`,
  });
}

function renderCatPanel(panel, sum) {
  const cats = Object.entries(sum.byCat).sort((a, b) => b[1] - a[1]);
  const limits = limitStatus(currentMonth);
  const limByCat = new Map(limits.map((l) => [l.category, l]));
  if (!cats.length && !limits.length) { panel.innerHTML = emptyCard("No paid expenses this month yet."); return; }
  const total = cats.reduce((s, [, v]) => s + v, 0);
  const data = cats.map(([label, value], i) => ({ label, value, color: CHART_COLORS[i % CHART_COLORS.length] }));
  if (data.length) panel.append(donut(data, { centerLabel: "spent" }));

  // A limit with nothing spent against it yet is still the plan — show it.
  const rows = [...data];
  for (const l of limits) {
    if (!sum.byCat[l.category]) rows.push({ label: l.category, value: 0, color: "var(--c-faint)" });
  }

  const list = el("div", { style: "margin-top:18px" });
  rows.forEach((d) => {
    const pct = total ? Math.round((d.value / total) * 100) : 0;
    const row = el("div", { class: "cat-row", html: `
      <span class="cat-dot" style="background:${d.color}"></span>
      <span class="small strong truncate" style="min-width:86px">${esc(d.label)}</span>
      <span class="cat-bar-track"><span class="cat-bar" style="width:${pct}%;background:${d.color}"></span></span>
      <span class="cat-amt num">${fmtCompact(d.value)}</span>
      <span class="cat-pct num">${pct}%</span>
    ` });
    list.append(row);
    const l = limByCat.get(d.label);
    if (l) list.append(limitLine(l));
  });
  panel.append(list);
}

function renderTitlePanel(panel, analysis) {
  const titles = analysis.titles;
  if (!titles.length) { panel.innerHTML = emptyCard("No paid expenses this month yet."); return; }

  const list = el("div", { class: "title-list" });
  const items = titles.map((t, i) => titleItem(t, i, (keep) => collapseOthers(keep)));
  const rest = items.slice(TOP_TITLES);

  function collapseOthers(keep) {
    for (const it of items) if (it !== keep) it.collapse();
  }

  items.slice(0, TOP_TITLES).forEach((it) => list.append(it.node));
  panel.append(list);

  if (!rest.length) return;

  const more = el("button", { type: "button", class: "btn btn-ghost btn-sm title-more" });
  const paintLabel = () => {
    more.textContent = titlesExpanded ? "Show less" : `Show ${rest.length} more`;
    more.setAttribute("aria-expanded", String(titlesExpanded));
  };
  const reveal = (animate) => {
    rest.forEach((it) => list.append(it.node));
    if (animate) {
      anim(rest.map((it) => it.node), { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.28, stagger: 0.04, ease: "power2.out" });
      animateCharts(list);
    }
  };

  more.addEventListener("click", () => {
    buzz(6);
    titlesExpanded = !titlesExpanded;
    if (titlesExpanded) reveal(true);
    else rest.forEach((it) => { it.collapse(); it.node.remove(); });
    paintLabel();
  });

  if (titlesExpanded) reveal(false);
  paintLabel();
  panel.append(more);
}

/**
 * One title in the breakdown: a button row, and the transactions behind it
 * revealed underneath. Only one row is open at a time — two open lists on a
 * phone is just scrolling.
 */
function titleItem(t, i, onOpen) {
  const node = el("div", { class: "title-item" });
  const pct = Math.round(t.share * 100);
  const color = i < TOP_TITLES ? CHART_COLORS[i % CHART_COLORS.length] : "var(--c-faint)";

  const meta = [esc(t.category || "Others")];
  if (t.recurrence && t.recurrence !== "one-time") meta.push(esc(t.recurrence));
  if (t.count > 1) meta.push(`avg ${fmtMoney(t.avg)}`);
  if (t.isAdjustment) meta.push(`${icon("scale", 10)} adjustment`);

  const row = el("button", {
    type: "button",
    class: "title-row",
    "aria-expanded": "false",
    html: `
      <span class="title-rank num ${i < 3 ? "is-top" : ""}">${i + 1}</span>
      <span class="title-main">
        <span class="title-name truncate">${esc(t.title)}${t.count > 1 ? `<span class="badge title-count">×${t.count}</span>` : ""}</span>
        <span class="title-meta xsmall muted">${meta.join(" · ")}</span>
        <span class="cat-bar-track"><span class="cat-bar" style="width:${Math.max(2, pct)}%;background:${color}"></span></span>
      </span>
      <span class="title-right">
        <span class="title-amt num">${fmtCompact(t.total)}</span>
        <span class="title-pct num">${pct}%</span>
      </span>`,
  });

  let detail = null;
  const api = {
    node,
    collapse() {
      if (!detail) return;
      detail.remove();
      detail = null;
      row.setAttribute("aria-expanded", "false");
    },
  };

  row.addEventListener("click", () => {
    buzz(6);
    if (detail) return api.collapse();
    onOpen(api);
    detail = titleDetail(t);
    node.append(detail);
    row.setAttribute("aria-expanded", "true");
    anim([...detail.children], { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.24, stagger: 0.03, ease: "power2.out" });
  });

  node.append(row);
  return api;
}

function titleDetail(t) {
  const wrap = el("div", { class: "title-detail" });
  const rows = [...t.entries].sort((a, b) => (spendDate(a) < spendDate(b) ? 1 : -1)); // newest first
  for (const e of rows) {
    const acc = e.accountId ? accountName(e.accountId) : "";
    wrap.append(el("button", {
      type: "button",
      class: "title-detail-row",
      html: `<span class="xsmall muted truncate">${shortDate(spendDate(e))}${acc ? ` · ${esc(acc)}` : ""}</span>
             <span class="small num strong">${fmtCompact(e.amount)}</span>`,
      onclick: (ev) => { ev.stopPropagation(); buzz(8); addExpenseSheet(e); },
    }));
  }
  return wrap;
}

/* ============================================================
   Spending patterns
   ============================================================ */

function renderPatterns(root, a, insights) {
  if (a.count < 3) {
    root.innerHTML = emptyCard("Patterns show up once there are a few paid expenses.", "bar-chart");
    return;
  }

  // --- the week ---
  const week = el("div", { class: "pattern-block" });
  week.append(weekdayBars(a.weekday.perDay, a.weekday.topIndex));
  const weekIns = insightById(insights, "weekend") || insightById(insights, "weekday-peak");
  week.append(el("div", {
    class: "pattern-cap small",
    html: a.count < 8
      ? "Not enough days yet to see a weekly pattern."
      : weekIns ? weekIns.html : "Spending is spread fairly evenly across the week.",
  }));
  root.append(week);

  // --- the month, in thirds ---
  const phase = el("div", { class: "pattern-block" });
  phase.append(phaseBar(a.phase, { lastDay: a.daysInMonth }));
  const phaseIns = insightById(insights, "front-loaded") || insightById(insights, "back-loaded");
  if (phaseIns) phase.append(el("div", { class: "pattern-cap small", html: phaseIns.html }));
  root.append(phase);

  // --- the numbers ---
  const nums = el("div", { class: "pattern-block" });
  nums.append(statRow(a));
  const pace = a.projection ? insightById(insights, "pace") : null;
  if (pace) {
    nums.append(el("div", {
      class: `pace small ${pace.tone === "caution" ? "is-over" : ""}`,
      html: `${icon("clock", 14)}<span>${pace.html}</span>`,
    }));
  }
  root.append(nums);
}

function statRow(a) {
  const stat = (label, value, sub) => `
    <div class="stat">
      <div class="stat-l">${label}</div>
      <div class="stat-v num">${value}</div>
      <div class="stat-s">${sub}</div>
    </div>`;
  const days = a.daysElapsed || a.daysInMonth;
  return el("div", { class: "stat-row", html: [
    stat("Daily avg", fmtCompact(a.daily.avg), `over ${days} day${days === 1 ? "" : "s"}`),
    stat("Priciest day", a.daily.peak ? shortDate(a.daily.peak.date) : "—", a.daily.peak ? fmtCompact(a.daily.peak.total) : "nothing yet"),
    stat("No-spend days", String(a.daily.noSpendDays), `of ${days}`),
  ].join("") });
}

/* ============================================================
   Trend + split (unchanged)
   ============================================================ */

function renderTrend(root, ym) {
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const m = shiftMonth(ym, -i);
    const s = monthSummary(m);
    months.push({ label: monthLabel(m).slice(0, 3), income: s.income, spent: s.spent });
  }
  if (months.every((m) => !m.income && !m.spent)) { root.innerHTML = emptyCard("Nothing recorded in the last 6 months.", "bar-chart"); return; }
  root.append(trendBars(months));
  root.append(el("div", { class: "legend", html: `
    <span class="lg-item"><span class="lg-dot" style="background:#12B77F"></span> In</span>
    <span class="lg-item"><span class="lg-dot" style="background:#6248F5"></span> Out</span>
  ` }));
}

function renderSplit(root, sum) {
  if (!sum.spent) { root.innerHTML = emptyCard("No spending to split yet."); return; }
  root.append(splitBar(sum.recurringOut, sum.onceOut));
}
