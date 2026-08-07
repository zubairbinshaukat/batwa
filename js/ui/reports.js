// Reports: month browser, summary tiles, charts, insights. History has its own tab.

import { $, el, esc, anim } from "../util/dom.js";
import { fmtMoney, fmtCompact, monthLabel, thisMonth, shiftMonth } from "../util/format.js";
import { monthSummary } from "../ledger.js";
import { donut, trendBars, splitBar, animateCharts, CHART_COLORS } from "./charts.js";
import { icon, catIcon } from "./icons.js";

let currentMonth = thisMonth();

export function renderReports(view) {
  const ym = currentMonth;
  const sum = monthSummary(ym);
  const prev = monthSummary(shiftMonth(ym, -1));
  const isNow = ym === thisMonth();

  view.innerHTML = `
    <div class="month-nav">
      <button class="icon-btn" id="m-prev" aria-label="Previous month">${icon("chevron-left", 18)}</button>
      <div class="month-label">${monthLabel(ym)}</div>
      <button class="icon-btn" id="m-next" aria-label="Next month" ${isNow ? "disabled style='opacity:.35'" : ""}>${icon("chevron-right", 18)}</button>
    </div>

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

    <div id="insights" class="stack" style="margin-top:16px"></div>

    <div class="section-head"><h2>Spending by category</h2></div>
    <div class="card chart-card" id="cat-chart"></div>

    <div class="section-head"><h2>6-month trend</h2></div>
    <div class="card chart-card" id="trend-chart"></div>

    <div class="section-head"><h2>Fixed vs one-off</h2></div>
    <div class="card chart-card" id="split-chart"></div>
  `;

  $("#m-prev", view).addEventListener("click", () => { currentMonth = shiftMonth(currentMonth, -1); renderReports(view); });
  $("#m-next", view).addEventListener("click", () => {
    if (currentMonth < thisMonth()) { currentMonth = shiftMonth(currentMonth, 1); renderReports(view); }
  });

  renderInsights($("#insights", view), sum, prev);
  renderCatChart($("#cat-chart", view), sum);
  renderTrend($("#trend-chart", view), ym);
  renderSplit($("#split-chart", view), sum);

  anim(view.children, { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, stagger: 0.05, ease: "power2.out" });
  animateCharts(view);
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

function renderInsights(root, sum, prev) {
  const lines = [];
  const cats = Object.entries(sum.byCat).sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    const [top, amt] = cats[0];
    lines.push(`${catIcon(top, 13)} <b>${esc(top)}</b> was your biggest category this month at <b>${fmtMoney(amt)}</b>.`);
  }
  if (prev.spent > 0 && sum.spent > 0) {
    const diff = sum.spent - prev.spent;
    if (Math.abs(diff) > prev.spent * 0.1) {
      lines.push(diff < 0
        ? `${icon("trend-down", 13)} You spent <b>${fmtMoney(-diff)}</b> less than last month. Keep it up.`
        : `${icon("trend-up", 13)} Spending is up <b>${fmtMoney(diff)}</b> vs last month.`);
    }
  }
  if (sum.recurringOut > 0 && sum.spent > 0) {
    const pct = Math.round((sum.recurringOut / sum.spent) * 100);
    if (pct >= 40) lines.push(`${icon("repeat", 13)} <b>${pct}%</b> of this month's spending is recurring — your fixed baseline is <b>${fmtMoney(sum.recurringOut)}</b>.`);
  }
  for (const l of lines.slice(0, 2)) {
    root.append(el("div", { class: "insight", html: `<span class="spark">${icon("sparkles", 16)}</span><span>${l}</span>` }));
  }
}

function renderCatChart(root, sum) {
  const cats = Object.entries(sum.byCat).sort((a, b) => b[1] - a[1]);
  if (!cats.length) { root.innerHTML = emptyCard("No paid expenses this month yet."); return; }
  const total = cats.reduce((s, [, v]) => s + v, 0);
  const data = cats.map(([label, value], i) => ({ label, value, color: CHART_COLORS[i % CHART_COLORS.length] }));
  root.append(donut(data, { centerLabel: "spent" }));
  const list = el("div", { style: "margin-top:18px" });
  data.forEach((d) => {
    const pct = Math.round((d.value / total) * 100);
    list.append(el("div", { class: "cat-row", html: `
      <span class="cat-dot" style="background:${d.color}"></span>
      <span class="small strong" style="min-width:86px" class="truncate">${esc(d.label)}</span>
      <span class="cat-bar-track"><span class="cat-bar" style="width:${pct}%;background:${d.color}"></span></span>
      <span class="cat-amt num">${fmtCompact(d.value)}</span>
      <span class="cat-pct num">${pct}%</span>
    ` }));
  });
  root.append(list);
}

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
