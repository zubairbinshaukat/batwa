// Month sheet: the 1st to today, one cell per day, heat-tinted by what was
// spent. Opened by tapping the balance card on Home. Narrow-screen first —
// seven equal columns, weekend tinted, today ringed, tap a day to read it.

import { el, esc, anim, buzz } from "../util/dom.js";
import {
  DAYS, isoDate, monthLabel, shiftMonth, thisMonth, weekdayIndex,
  dayLabel, fmtMoney, fmtNum,
} from "../util/format.js";
import { state } from "../ledger.js";
import { dailySpend } from "../insights.js";
import { openSheet } from "./modals.js";
import { icon, catIcon } from "./icons.js";
import { accountName } from "./accounts.js";
import { isRevealed, setRevealed } from "./reveal.js";

const eyeIcon = (open) => icon(open ? "eye" : "eye-off", 16);

/** Cell-sized money: "450", "1.2k", "1.2L". Never wider than four glyphs. */
export function fmtCell(n) {
  const v = Math.round(Math.abs(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1e5) return `${trim(v / 1e3)}k`;
  return `${trim(v / 1e5)}L`;
}
function trim(x) {
  const s = x.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/** 0 = nothing spent, 1..4 = rising heat. */
function heatStep(total, max) {
  if (!(total > 0) || !(max > 0)) return 0;
  return Math.max(1, Math.min(4, Math.ceil((total / max) * 4)));
}

export function openMonthSheet(ym = thisMonth()) {
  let cur = ym;
  let firstPaint = true;

  openSheet(monthLabel(cur), (body) => {
    const paint = () => {
      body.innerHTML = "";
      body.append(buildBody(cur, {
        onMonth: (n) => {
          const next = shiftMonth(cur, n);
          if (next > thisMonth()) return;
          cur = next;
          buzz(6);
          const h = body.closest(".sheet")?.querySelector("h2");
          if (h) h.textContent = monthLabel(cur);
          firstPaint = false;
          paint();
        },
        onEye: () => { setRevealed(!isRevealed()); firstPaint = false; paint(); },
        stagger: firstPaint,
      }));
      firstPaint = false;
    };
    paint();
  });
}

function buildBody(ym, { onMonth, onEye, stagger }) {
  const { days, total } = dailySpend(state.entries, ym);
  const today = isoDate();
  const isCurrent = ym === thisMonth();
  const dim = daysInMonth(ym);
  const lastDay = isCurrent ? Number(today.slice(8, 10)) : dim;
  const blur = isRevealed() ? "" : "is-blurred";

  let max = 0;
  for (let d = 1; d <= lastDay; d++) {
    const t = days.get(dayIso(ym, d))?.total || 0;
    if (t > max) max = t;
  }
  const avg = lastDay ? total / lastDay : 0;

  const wrap = el("div", { class: "ms" });

  // ---- head: arrows, range, total, average ----
  const head = el("div", { class: "ms-head" });
  head.innerHTML = `
    <button class="icon-btn ms-arrow" data-n="-1" aria-label="Previous month">${icon("chevron-left", 17)}</button>
    <div class="ms-head-text">
      <div class="ms-range">Spent 1–${lastDay} ${monthLabel(ym).split(" ")[0].slice(0, 3)}</div>
      <div class="ms-total num ${blur}"><span class="blurable">${fmtMoney(total)}</span></div>
      <div class="ms-avg ${blur}">avg <span class="blurable">${fmtMoney(avg)}</span> / day</div>
    </div>
    <button class="icon-btn ms-eye" aria-label="${isRevealed() ? "Hide amounts" : "Show amounts"}" aria-pressed="${isRevealed()}">${eyeIcon(isRevealed())}</button>
    <button class="icon-btn ms-arrow" data-n="1" aria-label="Next month" ${isCurrent ? "disabled" : ""}>${icon("chevron-right", 17)}</button>
  `;
  head.querySelectorAll(".ms-arrow").forEach((b) => {
    b.addEventListener("click", () => { if (!b.disabled) onMonth(Number(b.dataset.n)); });
  });
  head.querySelector(".ms-eye").addEventListener("click", onEye);
  wrap.append(head);

  // ---- weekday header ----
  const dow = el("div", { class: "ms-dow" });
  dow.innerHTML = DAYS.map((d, i) => `<span class="${i >= 5 ? "is-we" : ""}">${d}</span>`).join("");
  wrap.append(dow);

  // ---- grid ----
  const grid = el("div", { class: `ms-grid ${blur}` });
  const lead = Math.max(0, weekdayIndex(dayIso(ym, 1)));
  for (let i = 0; i < lead; i++) grid.append(el("span", { class: "ms-pad" }));

  for (let d = 1; d <= dim; d++) {
    const iso = dayIso(ym, d);
    const future = isCurrent && d > lastDay;
    const t = days.get(iso)?.total || 0;
    const step = heatStep(t, max);
    const we = weekdayIndex(iso) >= 5;
    const cls = [
      "ms-cell", `h${step}`,
      we ? "is-we" : "",
      future ? "is-future" : "",
      iso === today ? "is-today" : "",
    ].filter(Boolean).join(" ");
    const cell = el("button", {
      class: cls, "data-d": iso, type: "button",
      disabled: future || false,
      "aria-label": `${dayLabel(iso)}${t ? `, ${fmtMoney(t)}` : ", nothing spent"}`,
    });
    cell.innerHTML = `<span class="ms-n">${d}</span>${
      t && !future ? `<span class="ms-v num blurable">${fmtCell(t)}</span>` : ""}`;
    grid.append(cell);
  }
  wrap.append(grid);

  // ---- the selected day's entries ----
  const panel = el("div", { class: `ms-day ${blur}` });
  wrap.append(panel);

  let selected = pickDefault(days, ym, lastDay, isCurrent ? today : null);
  const select = (iso) => {
    selected = iso;
    grid.querySelectorAll(".ms-cell").forEach((c) => c.classList.toggle("is-sel", c.dataset.d === iso));
    paintDay(panel, iso, days.get(iso));
  };
  grid.addEventListener("click", (ev) => {
    const c = ev.target.closest(".ms-cell");
    if (!c || c.disabled) return;
    buzz(6);
    select(c.dataset.d);
  });
  select(selected);

  if (stagger) {
    anim([...grid.querySelectorAll(".ms-cell")], { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.3, stagger: 0.012, ease: "power2.out" });
  }
  return wrap;
}

/** Today when it has spend (or is in this month), else the last day that does. */
function pickDefault(days, ym, lastDay, today) {
  if (today && days.get(today)?.total) return today;
  for (let d = lastDay; d >= 1; d--) {
    const iso = dayIso(ym, d);
    if (days.get(iso)?.total) return iso;
  }
  return today || dayIso(ym, lastDay);
}

function paintDay(panel, iso, bucket) {
  const list = bucket?.list || [];
  const total = bucket?.total || 0;
  panel.innerHTML = `
    <div class="ms-day-head">
      <span>${dayLabel(iso)}</span>
      <span class="num blurable">${fmtMoney(total)}</span>
    </div>`;
  if (!list.length) {
    panel.append(el("p", { class: "ms-empty" }, "Nothing spent this day."));
    return;
  }
  for (const e of list) {
    const row = el("div", { class: "ms-row" });
    row.innerHTML = `
      <span class="ms-row-ico">${catIcon(e.category, 15)}</span>
      <span class="grow truncate">
        <span class="strong small truncate" style="display:block">${esc(e.title)}</span>
        <span class="xsmall muted truncate" style="display:block">${esc(e.category)}${
          e.accountId && accountName(e.accountId) ? ` · ${esc(accountName(e.accountId))}` : ""}</span>
      </span>
      <span class="ms-row-amt num blurable">${fmtNum(e.amount)}</span>`;
    panel.append(row);
  }
}

function dayIso(ym, d) {
  return `${ym}-${String(d).padStart(2, "0")}`;
}
