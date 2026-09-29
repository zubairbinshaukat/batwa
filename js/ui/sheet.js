// The sheet layer: bottom sheets (mobile) / centered modals (desktop), plus
// the confirm and multi-choice sheets built on it.
//
// Split out of js/ui/modals.js so everything on the start-up path (Home, the
// accounts row, the month sheet, sync) can open a sheet without also pulling
// in the add/edit forms, which js/ui/lazy.js loads on demand. The one open
// sheet, its history entry and the back/Escape listeners live here and only
// here: modals.js imports them rather than keeping a second copy, so there is
// still exactly one sheet at a time whichever module opened it.

import { $, el, anim, animTo, trapFocus, motionOK, buzz, tune } from "../util/dom.js";

let current = null; // { backdrop, sheet, release, resolveClosed }
let pendingHooks = null; // collects onSheetMounted/onSheetClosed while build() runs

const isDesktop = () => matchMedia("(min-width: 640px)").matches;

export function sheetOpen() { return !!current; }

/** From inside build(): run fn once the sheet is in the DOM, so layout reads are valid. */
export function onSheetMounted(fn) { pendingHooks && pendingHooks.mounted.push(fn); }
/** From inside build(): run fn when the sheet closes — tear down observers here. */
export function onSheetClosed(fn) { pendingHooks && pendingHooks.closed.push(fn); }

/** Open a sheet. `build(body)` fills the content. Returns close(). */
export function openSheet(title, build, { onDismiss } = {}) {
  if (current) closeSheet(true);

  const backdrop = el("div", { class: "sheet-backdrop", onclick: () => closeSheet() });
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title });
  sheet.append(el("div", { class: "sheet-grab", "aria-hidden": "true" }));
  if (title) sheet.append(el("h2", {}, title));
  const body = el("div", {});
  sheet.append(body);

  const hooks = { mounted: [], closed: [] };
  pendingHooks = hooks;
  try { build(body); } finally { pendingHooks = null; }

  const root = $("#sheet-root");
  root.append(backdrop, sheet);
  // In the DOM but not yet painted: anything measured here lands in the first frame.
  for (const fn of hooks.mounted) fn();

  const release = trapFocus(sheet);
  current = { backdrop, sheet, release, onDismiss, closed: hooks.closed };

  // hardware back closes the sheet, not the app
  history.pushState({ batwaSheet: true }, "");

  anim(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.25 });
  if (isDesktop()) {
    // CSS already centres via translate(-50%,-50%). Animating y/yPercent here
    // would stack on top of that and throw the sheet off-screen — scale only.
    anim(sheet, { opacity: 0, scale: 0.92 },
      { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.4)" });
  } else {
    anim(sheet, { yPercent: 100 }, { yPercent: 0, duration: 0.45, ease: "power4.out" });
    wireSwipeToDismiss(sheet, backdrop);
  }

  // Skips inert panes — the quick-add sheet parks its off-screen tabs there,
  // so this lands on the tab you actually opened, not always the first one.
  const first = [...sheet.querySelectorAll("input, select, textarea, button")]
    .find((n) => !n.closest("[inert]"));
  if (first && !("ontouchstart" in window)) setTimeout(() => first.focus(), 80);
  return closeSheet;
}

/**
 * Native-feel swipe-down-to-dismiss for the mobile sheet.
 *
 * Who owns a touch is decided once, from its first 8px of travel, and never
 * revisited:
 *   • The browser owns vertical panning everywhere — the sheet is the scroll
 *     container — so content scrolls on the FIRST swipe, from anywhere.
 *   • This handler claims a gesture only when it is unambiguously a downward
 *     drag the sheet cannot absorb as scrolling (already at the top), or one
 *     that started on the grab handle / title. It claims by preventing the
 *     touchmove, which the browser only honours before it starts scrolling —
 *     hence the small classification window and the never-claim-upward rule.
 *   • Anything else is marked dead for the rest of that touch. The old code
 *     prevented the first moves speculatively and then bailed out; the browser
 *     had already written the gesture off as non-scrolling by then, which is
 *     why scrolling back up took three or four tries.
 * Release past 25% of the sheet height or a fast flick dismisses through the
 * SAME closeSheet() path (history/onDismiss included); otherwise it springs back.
 */
function wireSwipeToDismiss(sheet, backdrop) {
  const grab = sheet.querySelector(".sheet-grab");
  const header = sheet.querySelector("h2");
  const CLAIM = 8; // px of travel before a gesture is classified
  const isTextEntry = (n) => n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT" || n.isContentEditable);

  let id = null;         // the touch we're following
  let dead = true;       // classified as someone else's gesture (the default)
  let dragging = false;  // classified as ours
  let fromChrome = false; // started on the handle/title, which never scrolls
  let startX = 0, startY = 0, sheetH = 1;
  let moves = [];

  const find = (e) => [...e.changedTouches, ...e.touches].find((t) => t.identifier === id);

  function springBack() {
    if (typeof gsap === "undefined") { backdrop.style.opacity = ""; return; }
    if (motionOK()) {
      gsap.to(sheet, tune({ y: 0, duration: 0.35, ease: "power3.out" }));
      gsap.to(backdrop, tune({ opacity: 1, duration: 0.25 }));
    } else {
      gsap.set(sheet, { y: 0 });
      gsap.set(backdrop, { opacity: 1 });
    }
  }

  function onStart(e) {
    if (e.touches.length > 1) { // second finger: pinch/zoom, not a dismiss
      if (dragging) { dragging = false; springBack(); }
      dead = true;
      return;
    }
    const t = e.touches[0];
    const onChrome = (grab && grab.contains(t.target)) || (header && header.contains(t.target));
    dead = !onChrome && isTextEntry(t.target) && document.activeElement === t.target; // leave text editing alone
    dragging = false;
    fromChrome = !!onChrome;
    id = t.identifier;
    startX = t.clientX;
    startY = t.clientY;
    sheetH = sheet.getBoundingClientRect().height || sheet.offsetHeight || 1;
    moves = [{ t: performance.now(), y: startY }];
  }

  function onMove(e) {
    if (dead) return;
    const t = find(e);
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (!dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < CLAIM) return; // below intent threshold
      // Horizontal is the pager's, upward is content scrolling, and a sheet
      // with room left to scroll up keeps its own gesture. None of them ours.
      if (Math.abs(dx) > Math.abs(dy)) { dead = true; return; }
      if (!fromChrome && (dy <= 0 || sheet.scrollTop > 0)) { dead = true; return; }
      dragging = true;
    }

    if (e.cancelable) e.preventDefault(); // nothing may scroll under the drag
    moves.push({ t: performance.now(), y: t.clientY });
    if (moves.length > 6) moves.shift();

    const y = Math.max(0, dy); // ignore upward drag past the resting position
    const progress = Math.min(1, y / sheetH);
    if (typeof gsap !== "undefined") {
      gsap.set(sheet, { y });
      gsap.set(backdrop, { opacity: 1 - progress * 0.9 });
    } else {
      backdrop.style.opacity = String(1 - progress * 0.9);
    }
  }

  function onEnd(e) {
    if (!dragging) { dead = true; return; }
    dragging = false;
    dead = true;

    // touchcancel can carry stale coordinates — trust the last real sample.
    const t = find(e);
    const first = moves[0], last = moves[moves.length - 1];
    const endY = e.type === "touchcancel" || !t ? last.y : t.clientY;
    const dy = Math.max(0, endY - startY);
    const dt = Math.max(1, last.t - first.t);
    const velocity = (last.y - first.y) / dt; // px/ms, downward positive

    if (dy > sheetH * 0.25 || velocity > 0.6) {
      // Fold the drag offset into yPercent so closeSheet's own 0->100% exit
      // tween continues smoothly from here — one close path, no divergent
      // animation logic.
      if (typeof gsap !== "undefined") {
        const curY = gsap.getProperty(sheet, "y") || 0;
        const curPct = gsap.getProperty(sheet, "yPercent") || 0;
        const pct = Math.max(0, Math.min(100, curPct + (curY / sheetH) * 100));
        gsap.set(sheet, { y: 0, yPercent: pct });
      }
      closeSheet();
    } else {
      springBack();
    }
  }

  sheet.addEventListener("touchstart", onStart, { passive: true });
  sheet.addEventListener("touchmove", onMove, { passive: false });
  sheet.addEventListener("touchend", onEnd);
  sheet.addEventListener("touchcancel", onEnd);
}

export function closeSheet(fromPop = false) {
  if (!current) return;
  const { backdrop, sheet, release, onDismiss, closed } = current;
  current = null;
  release();
  for (const fn of closed || []) { try { fn(); } catch (err) { console.warn(err); } }
  onDismiss && onDismiss();
  if (!fromPop && history.state && history.state.batwaSheet) history.back();

  animTo(backdrop, { opacity: 0, duration: 0.22, onComplete: () => backdrop.remove() });
  if (isDesktop()) {
    animTo(sheet, { opacity: 0, scale: 0.94, duration: 0.22, ease: "power2.in", onComplete: () => sheet.remove() });
  } else {
    animTo(sheet, { yPercent: 100, duration: 0.32, ease: "power3.in", onComplete: () => sheet.remove() });
  }
}

window.addEventListener("popstate", () => { if (current) closeSheet(true); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && current) closeSheet(); });

/* ============================================================
   Small building blocks shared by every sheet
   ============================================================ */

export function toggleRow(labelText, checked, onFlip) {
  let on = checked;
  const sw = el("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(on) });
  sw.addEventListener("click", () => {
    on = !on;
    sw.setAttribute("aria-checked", String(on));
    buzz(6);
    onFlip(on);
  });
  const row = el("div", { class: "toggle-row" }, el("span", { class: "strong small" }, labelText), sw);
  return row;
}

/* ============================================================
   Confirm / choice sheets
   ============================================================ */

/** Yes/no confirm. Resolves boolean. */
export function confirmSheet({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openSheet(title, (body) => {
      body.append(el("p", { class: "muted", style: "margin-bottom:16px" }, message));
      body.append(
        el("div", { class: "form-actions" },
          el("button", { class: "btn btn-ghost", onclick: () => { finish(false); closeSheet(); } }, "Cancel"),
          el("button", {
            class: danger ? "btn btn-danger" : "btn btn-primary",
            onclick: () => { finish(true); closeSheet(); },
          }, confirmLabel)
        )
      );
    }, { onDismiss: () => finish(false) });
  });
}

/** Multi-option choice. Resolves the picked value or null. */
export function chooseSheet({ title, message, options }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openSheet(title, (body) => {
      if (message) body.append(el("p", { class: "muted", style: "margin-bottom:16px" }, message));
      const stack = el("div", { class: "stack" });
      for (const opt of options) {
        stack.append(
          el("button", {
            class: `btn btn-block ${opt.style || "btn-ghost"}`,
            onclick: () => { finish(opt.value); closeSheet(); },
          }, opt.label)
        );
      }
      body.append(stack);
    }, { onDismiss: () => finish(null) });
  });
}
