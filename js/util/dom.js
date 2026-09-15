// Tiny DOM helpers. No framework, no virtual anything.

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

// ---- Motion: GSAP wrapper that respects prefers-reduced-motion ----
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
export const motionOK = () => !reduced.matches && typeof gsap !== "undefined";

/** gsap.fromTo if motion allowed, else jump to end state instantly. */
export function anim(targets, fromVars, toVars) {
  if (!targets || (targets.length !== undefined && !targets.length)) return null;
  if (motionOK()) return gsap.fromTo(targets, fromVars, toVars);
  if (typeof gsap !== "undefined") gsap.set(targets, { ...toVars, delay: 0, duration: 0, stagger: 0 });
  toVars.onComplete && toVars.onComplete();
  return null;
}

export function animTo(targets, toVars) {
  if (!targets || (targets.length !== undefined && !targets.length)) return null;
  if (motionOK()) return gsap.to(targets, toVars);
  if (typeof gsap !== "undefined") gsap.set(targets, { ...toVars, delay: 0, duration: 0, stagger: 0 });
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

/** Haptic tap where supported. */
export function buzz(ms = 10) {
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
