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
