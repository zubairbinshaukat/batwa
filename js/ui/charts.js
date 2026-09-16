// Hand-drawn SVG charts: donut, monthly trend bars, split bar.
// No libraries — everything renders offline.

import { el } from "../util/dom.js";
import { fmtCompact } from "../util/format.js";

export const CHART_COLORS = [
  "#6248F5", "#2FB6E9", "#12B77F", "#E8930C", "#EF4667",
  "#8B5CF6", "#0B87B8", "#F97362", "#64748B", "#B49AFF",
];

const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/**
 * Donut chart. data: [{ label, value, color }]. Center shows total.
 */
export function donut(data, { size = 190, stroke = 26, centerLabel = "" } = {}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, width: "100%", style: `max-width:${size}px;margin:0 auto;display:block` });
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;

  svg.append(svgEl("circle", { cx: c, cy: c, r, fill: "none", stroke: "var(--c-bg-deep)", "stroke-width": stroke }));

  let offset = circ * 0.25; // start at 12 o'clock
  for (const d of data) {
    if (!d.value) continue;
    const frac = d.value / total;
    const seg = svgEl("circle", {
      cx: c, cy: c, r, fill: "none",
      stroke: d.color, "stroke-width": stroke, "stroke-linecap": "butt",
      "stroke-dasharray": `${Math.max(0, frac * circ - 2)} ${circ}`,
      "stroke-dashoffset": offset,
      class: "donut-seg",
    });
    svg.append(seg);
    offset -= frac * circ;
  }

  const t1 = svgEl("text", {
    x: c, y: c - 4, "text-anchor": "middle",
    style: "font-size:22px;font-weight:800;fill:var(--c-ink);font-family:inherit",
  });
  t1.textContent = fmtCompact(total);
  const t2 = svgEl("text", {
    x: c, y: c + 16, "text-anchor": "middle",
    style: "font-size:10px;font-weight:600;fill:var(--c-muted);letter-spacing:0.08em;font-family:inherit",
  });
  t2.textContent = (centerLabel || "TOTAL").toUpperCase();
  svg.append(t1, t2);
  return svg;
}

/**
 * Monthly trend: grouped bars (in vs out) over months.
 * data: [{ label, income, spent }]
 */
export function trendBars(data, { height = 170 } = {}) {
  const W = 340, H = height, padB = 24, padT = 14;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%" });
  const max = Math.max(1, ...data.flatMap((d) => [d.income, d.spent]));
  const slot = W / data.length;
  const barW = Math.min(14, slot / 3.2);
  const scale = (v) => (v / max) * (H - padB - padT);

  data.forEach((d, i) => {
    const cx = slot * i + slot / 2;
    const hIn = scale(d.income), hOut = scale(d.spent);
    svg.append(svgEl("rect", {
      x: cx - barW - 2, y: H - padB - hIn, width: barW, height: Math.max(hIn, 2),
      rx: barW / 2.4, fill: "#12B77F", class: "bar-anim",
    }));
    svg.append(svgEl("rect", {
      x: cx + 2, y: H - padB - hOut, width: barW, height: Math.max(hOut, 2),
      rx: barW / 2.4, fill: "#6248F5", class: "bar-anim",
    }));
    const t = svgEl("text", {
      x: cx, y: H - 7, "text-anchor": "middle",
      style: "font-size:10px;font-weight:600;fill:var(--c-muted);font-family:inherit",
    });
    t.textContent = d.label;
    svg.append(t);
  });
  return svg;
}

/**
 * One-time vs recurring split: a single rounded stacked bar.
 */
export function splitBar(recurring, once) {
  const total = recurring + once;
  const wrap = el("div", {});
  const track = el("div", {
    style: "display:flex;height:16px;border-radius:8px;overflow:hidden;background:var(--c-bg-deep);",
  });
  if (total > 0) {
    const rp = Math.round((recurring / total) * 100);
    track.append(
      el("div", { style: `width:${rp}%;background:linear-gradient(90deg,#6248F5,#8B5CF6);`, class: "bar-anim" }),
      el("div", { style: `width:${100 - rp}%;background:linear-gradient(90deg,#2FB6E9,#5BC9F0);`, class: "bar-anim" }),
    );
  }
  wrap.append(track);
  wrap.append(el("div", { class: "legend", html: `
    <span class="lg-item"><span class="lg-dot" style="background:#6248F5"></span> Recurring · ${fmtCompact(recurring)}</span>
    <span class="lg-item"><span class="lg-dot" style="background:#2FB6E9"></span> One-time · ${fmtCompact(once)}</span>
  ` }));
  return wrap;
}

const WD_SHORT = ["M", "T", "W", "T", "F", "S", "S"];
const WD_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Seven mini bars, one per weekday (Mon first), scaled by spend *per day* so a
 * month with three Fridays and four Mondays still compares fairly.
 * `topIndex` lights the priciest day; -1 lights none.
 */
export function weekdayBars(perDay, topIndex = -1, { height = 120 } = {}) {
  const vals = Array.from({ length: 7 }, (_, i) => Number(perDay?.[i]) || 0);
  const W = 340, H = height, padB = 22, padT = 10;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%" });
  const max = Math.max(1, ...vals);
  const slot = W / 7;
  const barW = Math.min(30, slot * 0.54);

  vals.forEach((v, i) => {
    const isTop = i === topIndex;
    const h = Math.max(3, (v / max) * (H - padB - padT));
    const rect = svgEl("rect", {
      x: slot * i + (slot - barW) / 2,
      y: H - padB - h,
      width: barW, height: h,
      rx: Math.min(8, barW / 2.6),
      fill: isTop ? "var(--c-violet)" : i >= 5 ? "var(--wd-bar-2)" : "var(--wd-bar-1)",
      class: "bar-anim",
    });
    const tip = svgEl("title");
    tip.textContent = `${WD_FULL[i]} · ${fmtCompact(v)} per day`;
    rect.append(tip);
    svg.append(rect);

    const lbl = svgEl("text", {
      x: slot * i + slot / 2, y: H - 6, "text-anchor": "middle",
      style: `font-size:10px;font-weight:${isTop ? 800 : 600};fill:${isTop ? "var(--c-ink)" : "var(--c-muted)"};font-family:inherit`,
    });
    lbl.textContent = WD_SHORT[i];
    svg.append(lbl);
  });
  return svg;
}

/**
 * Where in the month the money went: one stacked bar for days 1–10 / 11–20 / 21–end.
 */
export function phaseBar({ early = 0, mid = 0, late = 0 } = {}, { lastDay = 30 } = {}) {
  const total = early + mid + late;
  const pct = (v) => (total > 0 ? (v / total) * 100 : 0);
  const wrap = el("div", {});
  const track = el("div", {
    style: "display:flex;height:16px;border-radius:8px;overflow:hidden;background:var(--c-bg-deep);",
  });
  if (total > 0) {
    track.append(
      el("div", { style: `width:${pct(early)}%;background:linear-gradient(90deg,#6248F5,#8B5CF6);`, class: "bar-anim" }),
      el("div", { style: `width:${pct(mid)}%;background:linear-gradient(90deg,#2FB6E9,#5BC9F0);`, class: "bar-anim" }),
      el("div", { style: `width:${pct(late)}%;background:linear-gradient(90deg,#0E9F6E,#16C79A);`, class: "bar-anim" }),
    );
  }
  wrap.append(track);
  wrap.append(el("div", { class: "legend", html: `
    <span class="lg-item"><span class="lg-dot" style="background:#6248F5"></span> 1–10 · ${Math.round(pct(early))}%</span>
    <span class="lg-item"><span class="lg-dot" style="background:#2FB6E9"></span> 11–20 · ${Math.round(pct(mid))}%</span>
    <span class="lg-item"><span class="lg-dot" style="background:#0E9F6E"></span> 21–${lastDay} · ${Math.round(pct(late))}%</span>
  ` }));
  return wrap;
}

/** GSAP entrance for charts inside a container (safe without GSAP). */
export function animateCharts(root) {
  if (typeof gsap === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const segs = root.querySelectorAll(".donut-seg");
  if (segs.length) gsap.fromTo(segs, { opacity: 0 }, { opacity: 1, duration: 0.5, stagger: 0.08, ease: "power2.out" });
  const bars = root.querySelectorAll("rect.bar-anim");
  if (bars.length) gsap.fromTo(bars, { scaleY: 0, transformOrigin: "bottom" }, { scaleY: 1, duration: 0.6, stagger: 0.04, ease: "power3.out" });
  const divs = root.querySelectorAll("div.bar-anim");
  if (divs.length) gsap.fromTo(divs, { scaleX: 0, transformOrigin: "left" }, { scaleX: 1, duration: 0.7, ease: "power3.out" });
  const catBars = root.querySelectorAll(".cat-bar");
  if (catBars.length) gsap.fromTo(catBars, { scaleX: 0, transformOrigin: "left" }, { scaleX: 1, duration: 0.6, stagger: 0.05, ease: "power3.out" });
}
