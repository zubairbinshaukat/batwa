// Performance tiers: high / medium / low, so weaker phones never even start
// heavy motion or glass effects while stronger ones look exactly as before.
//
// The choice lives in localStorage, like theme — the inline script in
// index.html resolves the SAME tiers before first paint (mirrors this file;
// keep both in step) so nothing heavy ever gets a chance to start before this
// module loads. js/util/dom.js reads perfTier() to decide how anim()/animTo()
// and the direct gsap call sites behave; "high" must stay pixel-identical to
// the app before tiers existed.

import { APP_VERSION } from "./config.js";

const KEY = "batwa.perf";
const AUTO_KEY = "batwa.perfAuto";
const MODES = ["auto", "high", "medium", "low"];
const TIERS = ["high", "medium", "low"];
const AUTO_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days — mirrors the head script

const listeners = new Set();
let smoothnessStarted = false;

/** "auto" | "high" | "medium" | "low" — what the user picked. */
export function getPerfMode() {
  try {
    const v = localStorage.getItem(KEY);
    if (MODES.includes(v)) return v;
  } catch {}
  return "auto";
}

/**
 * "high" | "medium" | "low" — the tier actually in effect right now.
 * Normally just reads what the head script already wrote. If that's missing
 * (the head script threw, or something read this before it ran) this falls
 * back to resolving it the same way the head script does, and WRITES both
 * attributes so CSS and every later JS read agree from here on — it must
 * never blindly default to "high", which would start heavy effects on a
 * phone that reduce-motion or the heuristic would have put on "low".
 */
export function perfTier() {
  const t = document.documentElement.dataset.perf;
  if (TIERS.includes(t)) return t;
  const mode = getPerfMode();
  const tier = resolveTier(mode);
  try {
    document.documentElement.dataset.perf = tier;
    if (!document.documentElement.dataset.perfMode) document.documentElement.dataset.perfMode = mode;
  } catch {}
  return tier;
}

/**
 * The saved auto-measurement record. Two shapes share the one key:
 *   - a confirmed verdict:  { tier: "low", v, at }
 *   - a first "struggling" strike, not yet confirmed: { strikes: 1, v, at }
 * (See startSmoothnessCheck() for why a single ordinary sample never commits
 * a tier on its own.) Malformed data of either shape is treated as absent.
 */
function readAuto() {
  try {
    const raw = localStorage.getItem(AUTO_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved.at !== "number") return null;
    if (saved.tier !== undefined && !TIERS.includes(saved.tier)) return null;
    if (saved.strikes !== undefined && typeof saved.strikes !== "number") return null;
    return saved;
  } catch { return null; }
}

/** A saved auto measurement only counts once it matches this build and isn't stale. */
function isFresh(saved) {
  return !!saved && saved.v === APP_VERSION && Date.now() - saved.at < AUTO_MAX_AGE;
}

/** Same heuristic the head script runs, minus the version check it can't do. */
function heuristicTier() {
  try {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "low";
    const nav = navigator;
    const mem = nav.deviceMemory;
    const cores = nav.hardwareConcurrency;
    const saveData = !!(nav.connection && nav.connection.saveData);
    if (saveData) return "low";
    if (typeof mem === "number") {
      if (mem <= 2 || cores <= 2) return "low";
      if (mem <= 4 || cores <= 4) return "medium";
      return "high";
    }
    // no deviceMemory (Safari/iOS, Firefox) — never go below medium on cores
    // alone; startSmoothnessCheck() catches the phones that actually struggle.
    if (typeof cores === "number" && cores <= 2) return "medium";
    return "high";
  } catch { return "high"; }
}

/**
 * Mirrors the head script's own resolution order (explicit mode, then reduce
 * motion, then a saved verdict, then the hardware heuristic) — see
 * heuristicTier() for the reduce-motion/hardware part. Only a CONFIRMED "low"
 * verdict is authoritative here; a strike-only record never sets a tier on
 * its own, same rule the head script follows.
 */
function resolveTier(mode) {
  if (mode === "high" || mode === "medium" || mode === "low") return mode; // explicit choice wins
  const saved = readAuto();
  if (saved && saved.v !== APP_VERSION) {
    try { localStorage.removeItem(AUTO_KEY); } catch {} // different build — strikes and verdicts both reset
  } else if (saved && saved.tier === "low") {
    if (isFresh(saved)) return "low";
    try { localStorage.removeItem(AUTO_KEY); } catch {} // confirmed verdict aged out
  }
  return heuristicTier();
}

function applyTier(tier, notify = true) {
  document.documentElement.dataset.perf = tier;
  if (!notify) return;
  for (const fn of listeners) { try { fn(tier); } catch {} }
}

/**
 * Saves the mode, re-resolves the tier and updates data-perf live.
 * Returns the tier now in effect.
 */
export function setPerfMode(mode) {
  const m = MODES.includes(mode) ? mode : "auto";
  try { localStorage.setItem(KEY, m); } catch {}
  // data-perf-mode is the raw choice — base.css's reduced-motion block reads
  // it to let an explicit "high" win over the OS preference, same as the
  // head script's tier resolution already does. Keep it in step with getPerfMode().
  document.documentElement.dataset.perfMode = m;
  const tier = resolveTier(m);
  applyTier(tier);
  return tier;
}

/** Called when the effective tier actually changes (mode change, or a struggling verdict). */
export function onPerfChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function perfLabel(mode = getPerfMode()) {
  return mode === "high" ? "Full" : mode === "medium" ? "Reduced" : mode === "low" ? "Off" : "Auto";
}

// ---- Re-validate the head script's guess ----
// The head script can't import APP_VERSION, so on "auto" it treats any
// batwa.perfAuto under 30 days old as good. If that entry is actually from a
// different app version, drop it and re-run the plain heuristic so a stale
// "low" verdict from a past build doesn't stick around forever.
(function revalidate() {
  try {
    if (getPerfMode() !== "auto") return;
    const saved = readAuto();
    if (!saved || saved.v === APP_VERSION) return;
    localStorage.removeItem(AUTO_KEY);
    if (perfTier() === "low") applyTier(heuristicTier(), false);
  } catch {}
})();

/** Writes the one verdict that ever moves the tier: a confirmed "low". */
function commitLow() {
  try { localStorage.setItem(AUTO_KEY, JSON.stringify({ tier: "low", v: APP_VERSION, at: Date.now() })); } catch {}
  applyTier("low");
}

/**
 * One-shot smoothness probe, meant to be called once the app is unlocked and
 * home has rendered. Only runs on "auto", only when the tier isn't already
 * "low", and only when there's no CONFIRMED fresh verdict already on file —
 * a mere strike (see below) never blocks a re-check, since it takes a second
 * sample to confirm one.
 *
 * Samples ~2s of requestAnimationFrame frame-times (works everywhere,
 * including Safari) plus, where supported, the Long Animation Frame API as a
 * second signal for main-thread blocking that frame-time alone can miss.
 *
 * A single noisy sample must never demote a strong phone permanently (it
 * only gets corrected on the next app version), so there are two verdicts
 * worse than "ok":
 *   - "severe" (median > 45ms, or >50% of frames > 50ms) commits to "low"
 *     immediately — this is unambiguous, not noise.
 *   - "struggling" (the more common, milder threshold) only records a
 *     strike; a SECOND "struggling" sample in a later session, same app
 *     version, then commits to "low". A smooth ("ok") sample clears a
 *     pending strike. A confirmed "low" is never saved except from "severe"
 *     or a second "struggling" strike, so this can only ever move the tier
 *     DOWN, never up.
 */
export function startSmoothnessCheck() {
  if (smoothnessStarted) return;
  smoothnessStarted = true;
  try {
    if (getPerfMode() !== "auto") return;
    if (perfTier() === "low") return;
    const already = readAuto();
    if (already && already.tier === "low" && isFresh(already)) return;

    const DURATION = 2000;
    const start = performance.now();
    let last = start;
    let frames = 0, slow = 0, verySlow = 0;
    const intervals = [];
    let loafBlocking = 0;
    let aborted = false;
    let po = null;

    if (typeof PerformanceObserver !== "undefined") {
      try {
        const supported = PerformanceObserver.supportedEntryTypes || [];
        if (supported.includes("long-animation-frame")) {
          // No buffered:true — a LoAF from before this window (e.g. startup
          // jank) isn't this measurement's problem. startTime is re-checked
          // in the callback too, since a queued/late entry can still arrive
          // for a frame at or after `start`.
          po = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.startTime >= start) loafBlocking += entry.blockingDuration || 0;
            }
          });
          po.observe({ type: "long-animation-frame" });
        }
      } catch {}
    }

    function finish(verdict) {
      if (po) { try { po.disconnect(); } catch {} }
      if (aborted || !verdict) return;
      if (verdict === "severe") { commitLow(); return; }
      if (verdict === "struggling") {
        const prev = readAuto();
        if (prev && prev.v === APP_VERSION && typeof prev.strikes === "number" && prev.strikes >= 1) {
          commitLow(); // second strike, same build — confirmed
        } else {
          try { localStorage.setItem(AUTO_KEY, JSON.stringify({ strikes: 1, v: APP_VERSION, at: Date.now() })); } catch {}
        }
        return;
      }
      // "ok" — clears a pending strike; never touches a confirmed "low"
      // (startSmoothnessCheck() wouldn't have run this far if there were one).
      const prev = readAuto();
      if (prev && typeof prev.strikes === "number") { try { localStorage.removeItem(AUTO_KEY); } catch {} }
    }

    function frame(now) {
      if (document.hidden) { aborted = true; finish(null); return; }
      const dt = now - last;
      last = now;
      if (frames > 0) { // the first callback has no real "previous frame" to diff against
        intervals.push(dt);
        if (dt > 40) slow++;
        if (dt > 50) verySlow++;
      }
      frames++;
      if (now - start < DURATION) { requestAnimationFrame(frame); return; }
      const n = intervals.length;
      if (!n) { finish(null); return; }
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(n / 2)];
      const severe = median > 45 || verySlow / n > 0.5;
      const struggling = !severe && (median > 28 || slow / n > 0.25 || loafBlocking > 400);
      finish(severe ? "severe" : struggling ? "struggling" : "ok");
    }
    requestAnimationFrame(frame);
  } catch {}
}

/* ============================================================
   Cold-start timing marks — dev-only visibility into what item 8 of the
   "lock screen sooner" pass actually bought. Every call site just calls
   mark(name); this file is the one place that turns them into console
   output, and only when the user opted in.
   ============================================================ */

const MARK_NAMES = ["batwa:boot", "batwa:db", "batwa:lock-shown", "batwa:bio-get", "batwa:unlocked"];

/** Records a named timing mark. Wrapped so a hostile/old Performance API can never break boot. */
export function mark(name) {
  try { performance.mark(name); } catch {}
}

/**
 * One-line summary of ms-since-navigation-start for every mark that actually
 * fired this boot — silent unless localStorage "batwa.debugPerf" === "1".
 * Missing marks (e.g. no lock screen on a session restore) are just left out.
 */
export function logMarks() {
  try {
    if (localStorage.getItem("batwa.debugPerf") !== "1") return;
  } catch { return; }
  try {
    const parts = MARK_NAMES
      .map((name) => {
        const e = performance.getEntriesByName(name, "mark")[0];
        return e ? `${name}=${Math.round(e.startTime)}ms` : null;
      })
      .filter(Boolean);
    if (parts.length) console.info("[batwa perf] " + parts.join("  "));
  } catch {}
}
