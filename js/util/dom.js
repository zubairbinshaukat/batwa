// Tiny DOM helpers. No framework, no virtual anything.

import { perfTier } from "../perf.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
}

// ---- Motion: GSAP wrapper that respects the performance tier ----
//
// motionOK() used to key off prefers-reduced-motion directly. It now keys off
// perfTier() instead, because the tier already folds reduce-motion in for
// "auto" mode (see index.html's head script and js/perf.js) — and doing it
// this way lets a user's EXPLICIT "high" choice win over reduce-motion, the
// same way it wins over every other auto signal. Every existing
// `if (motionOK())` call site therefore skips automatically on "low", with no
// changes needed there.
export const motionOK = () => perfTier() !== "low" && typeof gsap !== "undefined";

/** 1 / 0.6 / 0 — how much motion the tier allows. For simple duration math at direct gsap call sites. */
export const motionScale = () => (perfTier() === "low" ? 0 : perfTier() === "medium" ? 0.6 : 1);

/**
 * Copies `vars` with its TIMING scaled down for "medium": durations x0.6,
 * delays and staggers x0.5, "back.*"/"elastic.*" eases swapped for a plain
 * "power2.out". A no-op copy on every other tier, so callers can always pass
 * `tune(vars)` and get byte-identical behaviour on "high".
 *
 * Deliberately never touches x/y/scale — those are POSITIONS, and this is
 * used on toVars (destinations) at every call site, including exits like
 * closeSheet()'s yPercent:100 and drag-reorder's y:0 snap-back. Shrinking a
 * destination toward its start would leave the element short of where it's
 * meant to end up. See tuneFrom() for the one place a position IS safe to
 * shrink: a literal fromVars, which is discarded the instant the tween starts.
 */
export function tune(vars) {
  if (!vars || perfTier() !== "medium") return vars;
  const v = { ...vars };
  if (typeof v.duration === "number") v.duration *= 0.6;
  if (typeof v.delay === "number") v.delay *= 0.5;
  if (typeof v.stagger === "number") v.stagger *= 0.5;
  if (typeof v.ease === "string" && /^(back|elastic)\./.test(v.ease)) v.ease = "power2.out";
  return v;
}

/**
 * tune(), plus pulls a starting `scale` a quarter of the way toward 1 (e.g.
 * 0.6 -> 0.9) and halves starting x/y offsets — safe ONLY for a literal
 * fromVars object, never for a destination. Used exclusively by anim()'s
 * `fromVars` argument.
 */
export function tuneFrom(vars) {
  const v = tune(vars);
  if (!v || perfTier() !== "medium") return v;
  if (typeof v.scale === "number") v.scale = 1 - (1 - v.scale) * 0.25;
  for (const k of ["x", "y"]) {
    if (typeof v[k] === "number") v[k] = v[k] / 2;
  }
  return v;
}

/** True when either vars object animates opacity — used to decide the "low" fallback. */
const animatesOpacity = (fromVars, toVars) =>
  typeof fromVars?.opacity === "number" || typeof toVars?.opacity === "number";

/**
 * Strips callback/repeat props before an instant gsap.set(), so the caller
 * can call onComplete manually exactly once afterward without gsap firing it
 * a second time from inside the (zero-duration, but still a real tween) set.
 */
function instantVars(vars) {
  const { onComplete, onUpdate, onStart, onReverseComplete, onRepeat, repeat, repeatDelay, yoyo, ...rest } = vars;
  return { ...rest, delay: 0, duration: 0, stagger: 0 };
}

/**
 * "low" fallback for anim(): a real (but quick, 0.15s, no stagger/delay)
 * opacity-only fade, with every other prop snapped straight to its end value
 * so nothing moves. Always resolves onComplete exactly once, via the fade
 * tween itself — required for exit animations (dismiss(), closeSheet()) that
 * remove the node in onComplete.
 */
function lowFade(targets, fromVars, toVars) {
  const { opacity: toOpacity, onComplete, ...restTo } = toVars;
  const fromOpacity = typeof fromVars?.opacity === "number" ? fromVars.opacity : 1;
  gsap.set(targets, instantVars(restTo));
  return gsap.fromTo(targets, { opacity: fromOpacity }, {
    opacity: typeof toOpacity === "number" ? toOpacity : 1,
    duration: 0.15, delay: 0, stagger: 0, onComplete,
  });
}

/** gsap.fromTo if motion allowed, else jump to end state instantly. */
export function anim(targets, fromVars, toVars) {
  if (!targets || (targets.length !== undefined && !targets.length)) return null;
  if (motionOK()) return gsap.fromTo(targets, tuneFrom(fromVars), tune(toVars));
  if (typeof gsap !== "undefined") {
    if (perfTier() === "low" && animatesOpacity(fromVars, toVars)) return lowFade(targets, fromVars, toVars);
    gsap.set(targets, instantVars(toVars));
  }
  toVars.onComplete && toVars.onComplete();
  return null;
}

export function animTo(targets, toVars) {
  if (!targets || (targets.length !== undefined && !targets.length)) return null;
  if (motionOK()) return gsap.to(targets, tune(toVars));
  if (typeof gsap !== "undefined") {
    if (perfTier() === "low" && typeof toVars.opacity === "number") {
      const { opacity, onComplete, ...rest } = toVars;
      gsap.set(targets, instantVars(rest));
      return gsap.to(targets, { opacity, duration: 0.15, delay: 0, stagger: 0, onComplete });
    }
    gsap.set(targets, instantVars(toVars));
  }
  toVars.onComplete && toVars.onComplete();
  return null;
}

/** Focus trap for sheets/modals. Returns a release function. */
export function trapFocus(container) {
  const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const prev = document.activeElement;
  function onKey(e) {
    if (e.key !== "Tab") return;
    const items = $$(sel, container)
      .filter((n) => !n.disabled && n.offsetParent !== null && !n.closest("[inert]"));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }
  container.addEventListener("keydown", onKey);
  return () => {
    container.removeEventListener("keydown", onKey);
    prev && prev.focus && prev.focus();
  };
}

// ---- Haptics: on/off preference, like theme's localStorage pattern ----

const HAPTICS_KEY = "batwa.haptics";

/** True unless the user explicitly turned haptics off. Default is on. */
export function hapticsOn() {
  try { return localStorage.getItem(HAPTICS_KEY) !== "0"; } catch {}
  return true;
}

export function setHaptics(on) {
  try { localStorage.setItem(HAPTICS_KEY, on ? "1" : "0"); } catch {}
}

/** Whether this device can vibrate at all — iPhones can't. */
export const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

/** Haptic tap where supported, and only while the user has vibration on. */
export function buzz(ms = 10) {
  if (!hapticsOn()) return;
  try { navigator.vibrate && navigator.vibrate(ms); } catch {}
}

/**
 * Segmented tab strip. `options` is [{ label, value }]; `onPick` gets the value.
 * Roving tabindex: only the selected tab is in the Tab order, and Left/Right
 * (plus Home/End) move — and activate — within the strip, the way a tablist
 * is expected to behave.
 */
export function segmented(options, active, onPick) {
  const seg = el("div", { class: "segmented", role: "tablist" });
  let index = Math.max(0, options.findIndex((o) => o.value === active));

  const btns = options.map((opt, i) => {
    const on = i === index;
    const b = el("button", {
      type: "button",
      role: "tab",
      class: on ? "is-active" : "",
      "aria-selected": String(on),
      tabindex: on ? "0" : "-1",
      onclick: () => pick(i),
    }, opt.label);
    seg.append(b);
    return b;
  });

  function paint(focus = false) {
    btns.forEach((b, j) => {
      const on = j === index;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (focus && btns[index]) btns[index].focus();
  }

  function pick(i, focus = false) {
    if (i === index) return;
    index = i;
    paint(focus);
    buzz(6);
    onPick(options[i].value);
  }

  seg.addEventListener("keydown", (e) => {
    const n = options.length;
    if (!n) return;
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next == null) return;
    e.preventDefault();
    pick(next, true);
  });

  return seg;
}
