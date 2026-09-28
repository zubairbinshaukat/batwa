// Install Batwa: the right button for this browser, and the guide sheet behind
// it. Shared by the app (onboarding, Home banner, Settings) and about.html, so
// it imports nothing from the app's UI — its own tiny DOM helper, its own
// stylesheet (css/installguide.css), and a lazy QR module on desktop only.
//
//   Context          What the user sees
//   installed        nothing
//   prompt           "Install app"  -> the browser's own install prompt
//   ios-safari       "How to install" -> ••• / Share -> Add to Home Screen
//   ios-other        "How to install" -> Chrome/Edge/Firefox on iPhone
//   in-app           "How to install" -> open in Safari/Chrome first, copy link
//   android-manual   "How to install" -> ⋮ -> Install app (no prompt fired)
//   desktop          "Install on your phone" -> phone steps + QR code
//
// Real screenshots can sit next to each step: drop them in
// screenshots/install/ as <name>.avif + <name>.webp (720px wide) and add the
// name to SHOTS below. Until then each step shows a drawn glyph instead.

import { countInstallOnce, isInstalledApp } from "./installcount.js";

/** Screenshot names that exist on disk. See the header comment. */
const SHOTS = new Set([
  // "ios26-1-more", "ios26-2-share", "ios26-3-add", "ios26-4-confirm", "ios-5-home",
  // "ios18-1-share", "ios18-2-add",
  // "android-1-menu", "android-2-install", "android-3-confirm",
]);
const SHOT_DIR = "screenshots/install/";

/* ============================================================
   Detection
   ============================================================ */

let deferred = null;
const listeners = new Set();
const changed = () => {
  const ctx = installContext();
  for (const fn of listeners) { try { fn(ctx); } catch {} }
  paintButtons(ctx);
};

/*
 * "Installed, but this is a browser tab." Chrome never fires
 * beforeinstallprompt for an app that is already installed, which would make
 * every tab of an installed user look like "Android, no prompt" and nag with a
 * banner. So an install is remembered: set on `appinstalled` / an accepted
 * prompt, and by the install counter once the installed app has run (Android
 * and desktop share storage between the tab and the app; iOS does not, and
 * never needs it). A fresh beforeinstallprompt means it was uninstalled.
 */
const INSTALLED_KEY = "batwa.installed";
const COUNTED_KEY = "batwa.installCounted"; // written by js/installcount.js
function rememberInstalled(on) {
  try {
    if (on) localStorage.setItem(INSTALLED_KEY, "1");
    else { localStorage.removeItem(INSTALLED_KEY); localStorage.removeItem(COUNTED_KEY); }
  } catch {}
}
function knownInstalled() {
  try {
    return localStorage.getItem(INSTALLED_KEY) === "1" || localStorage.getItem(COUNTED_KEY) === "1";
  } catch { return false; }
}

// Chromium offers its own install prompt through this event. Kept for the
// button; the default mini-infobar is suppressed so the button is the one way.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e;
  rememberInstalled(false);
  changed();
});

// Android: the browser tab and the installed app share storage, so the count
// can go at once and the app's first launch will see it already done.
window.addEventListener("appinstalled", () => {
  deferred = null;
  rememberInstalled(true);
  countInstallOnce({ reason: "appinstalled" });
  changed();
});

const ua = () => String(navigator.userAgent || "");

export function isIOS() {
  return /iPhone|iPad|iPod/.test(ua()) || (/Macintosh/.test(ua()) && Number(navigator.maxTouchPoints) > 1);
}

/** Instagram, Facebook, TikTok… and Android WebViews: they cannot install. */
export function isInAppBrowser() {
  return /FBAN|FBAV|FB_IAB|Instagram|TikTok|musical_ly|Bytedance|LinkedInApp|Snapchat|Line\/|; wv\)/.test(ua());
}

/**
 * Safari's major version from `Version/NN`. iOS 26 froze the OS number in the
 * user agent, so Safari's own version is the reliable one. Null when absent.
 */
function safariMajor() {
  const m = ua().match(/Version\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Which of the contexts in the header comment this browser is in. */
export function installContext() {
  if (isInstalledApp()) return "installed";
  if (isInAppBrowser()) return "in-app";
  if (deferred) return "prompt";
  if (knownInstalled()) return "installed";
  if (isIOS()) return /CriOS|FxiOS|EdgiOS/.test(ua()) ? "ios-other" : "ios-safari";
  if (/Android/.test(ua())) return "android-manual";
  return "desktop";
}

/** Call `fn(context)` whenever the context changes. Returns an unsubscribe. */
export function onInstallContextChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The browser's own prompt. "accepted" | "dismissed" | "unavailable". */
export async function promptInstall() {
  if (!deferred) return "unavailable";
  const ev = deferred;
  deferred = null;
  try {
    ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome === "accepted") {
      rememberInstalled(true);
      countInstallOnce({ reason: "appinstalled" });
    }
    return outcome === "accepted" ? "accepted" : "dismissed";
  } catch {
    return "unavailable";
  } finally {
    changed();
  }
}

/* ============================================================
   The button
   ============================================================ */

function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * A button that is always the right one for this browser, and hides itself
 * once Batwa is installed. `className` styles it like the page around it.
 * `onInstalled` runs after an accepted native prompt. Pass `element` to adopt
 * a button already in the HTML: a page that paints it from the start never
 * shifts when the script arrives.
 */
export function installButton({ className = "btn btn-ghost", onInstalled = null, element = null } = {}) {
  const btn = element || h("button", { type: "button", class: className });
  btn.addEventListener("click", async () => {
    const ctx = installContext();
    if (ctx === "prompt") {
      const outcome = await promptInstall();
      if (outcome === "accepted") { onInstalled && onInstalled(); return; }
      if (outcome === "dismissed") return;
      // no prompt after all: fall through to the written steps
    }
    openInstallGuide(installContext() === "prompt" ? "android-manual" : installContext(), btn);
  });
  paintButton(btn, installContext());
  // Held weakly: Home and Settings repaint often, and a button that has left
  // the page must be free to go rather than kept alive by this module.
  buttons.add(new WeakRef(btn));
  return btn;
}

/** Every live install button, weakly. Repainted on each context change. */
const buttons = new Set();

function paintButton(btn, ctx) {
  // `hidden` alone loses to `.btn { display: inline-flex }`, so say it twice.
  btn.hidden = ctx === "installed";
  btn.style.display = ctx === "installed" ? "none" : "";
  btn.textContent = ctx === "prompt" ? "Install app"
    : ctx === "desktop" ? "Install on your phone" : "How to install";
  btn.dataset.installContext = ctx;
}

function paintButtons(ctx) {
  for (const ref of [...buttons]) {
    const btn = ref.deref();
    // Gone, or built, shown and since removed from the page: forget it.
    if (!btn || (btn.dataset.installSeen && !btn.isConnected)) { buttons.delete(ref); continue; }
    if (btn.isConnected) btn.dataset.installSeen = "1";
    paintButton(btn, ctx);
  }
}

/* ============================================================
   Steps
   ============================================================ */

const G = (d, extra = "") =>
  `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

// Drawn, generic glyphs — not Apple's SF Symbols, whose licence keeps them
// off the web. They only have to be recognisable, not identical.
const GLYPH = {
  dots: G('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'),
  kebab: G('<circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/>'),
  share: G('<path d="M8 9H6.5A1.5 1.5 0 0 0 5 10.5v8A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 17.5 9H16"/><path d="M12 14V3M8.5 6.5 12 3l3.5 3.5"/>'),
  add: G('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>'),
  toggle: G('<rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="16" cy="12" r="3" fill="currentColor"/>'),
  install: G('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M12 8v6M9.5 11.5 12 14l2.5-2.5"/>'),
  check: G('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  link: G('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  compass: G('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'),
};

const APP_ICON = '<img src="icons/favicon.svg" width="28" height="28" alt="" aria-hidden="true">';

function stepsFor(ctx) {
  const modernSafari = (safariMajor() ?? 26) >= 26;
  switch (ctx) {
    case "ios-safari":
      return {
        title: "Install Batwa on your iPhone",
        lead: "Takes about ten seconds in Safari.",
        steps: modernSafari ? [
          { glyph: "dots", text: "Tap <b>•••</b> next to the address bar.", shot: "ios26-1-more" },
          { glyph: "share", text: "Tap <b>Share</b>.", shot: "ios26-2-share" },
          { glyph: "add", text: "Scroll down and tap <b>Add to Home Screen</b>.", shot: "ios26-3-add" },
          { glyph: "toggle", text: "Keep <b>Open as Web App</b> on, then tap <b>Add</b>.", shot: "ios26-4-confirm" },
          { glyph: "app", text: "Open <b>Batwa</b> from your home screen.", shot: "ios-5-home" },
        ] : [
          { glyph: "share", text: "Tap the <b>Share</b> button in the toolbar (top right on iPad).", shot: "ios18-1-share" },
          { glyph: "add", text: "Scroll down and tap <b>Add to Home Screen</b>.", shot: "ios18-2-add" },
          { glyph: "check", text: "Tap <b>Add</b>." },
          { glyph: "app", text: "Open <b>Batwa</b> from your home screen.", shot: "ios-5-home" },
        ],
        foot: [
          "Don't see Add to Home Screen? Scroll to the end of the Share list, tap <b>Edit Actions</b> and add it.",
          "Notifications and full screen only work from the home-screen app.",
        ],
      };
    case "ios-other":
      return {
        title: "Install Batwa on your iPhone",
        lead: "Works from this browser too, and best from Safari.",
        steps: [
          { glyph: "share", text: "Tap the <b>Share</b> button in the address bar." },
          { glyph: "add", text: "Tap <b>Add to Home Screen</b> (you may need <b>More</b> first)." },
          { glyph: "check", text: "Tap <b>Add</b>." },
          { glyph: "app", text: "Open <b>Batwa</b> from your home screen." },
        ],
        foot: ["Notifications and full screen only work from the home-screen app."],
      };
    case "android-manual":
      return {
        title: "Install Batwa on your phone",
        lead: "From your browser's menu.",
        steps: [
          { glyph: "kebab", text: "Tap <b>⋮</b> at the top right of the browser.", shot: "android-1-menu" },
          { glyph: "install", text: "Tap <b>Install app</b> (or <b>Add to Home screen</b>).", shot: "android-2-install" },
          { glyph: "check", text: "Tap <b>Install</b>.", shot: "android-3-confirm" },
          { glyph: "app", text: "Open <b>Batwa</b> from your home screen or app drawer." },
        ],
        foot: ["Firefox: ⋮ → <b>Install</b>. Samsung Internet: ≡ → <b>Add page to</b> → <b>Home screen</b>."],
      };
    case "in-app":
      return {
        title: "Open Batwa in your browser first",
        lead: "Apps like Instagram and Facebook open links in a browser of their own, which can't install anything.",
        steps: [
          { glyph: isIOS() ? "dots" : "kebab", text: "Tap the menu in this screen's corner." },
          { glyph: "compass", text: `Tap <b>${isIOS() ? "Open in Safari" : "Open in browser"}</b> (or <b>Open in Chrome</b>).` },
          { glyph: "add", text: "Then tap <b>How to install</b> there." },
        ],
        copy: true,
        foot: [],
      };
    default: // desktop
      return {
        title: "Install Batwa on your phone",
        lead: "Batwa is made for your phone. Open it there, then add it to the home screen.",
        steps: [
          { glyph: "link", text: `Open <b>${location.host || "batwa.zubyr.dev"}</b> on your phone, or scan the code.` },
          { glyph: "share", text: "<b>iPhone:</b> Safari → <b>•••</b> or <b>Share</b> → <b>Add to Home Screen</b>." },
          { glyph: "kebab", text: "<b>Android:</b> Chrome → <b>⋮</b> → <b>Install app</b>." },
        ],
        qr: true,
        foot: [],
      };
  }
}

function shotFor(name) {
  if (!name || !SHOTS.has(name)) return null;
  return h("picture", { class: "ig-shot" },
    h("source", { type: "image/avif", srcset: `${SHOT_DIR}${name}.avif` }),
    h("img", {
      src: `${SHOT_DIR}${name}.webp`, width: "720", height: "480",
      loading: "lazy", decoding: "async", alt: "",
    }));
}

/* ============================================================
   The sheet
   ============================================================ */

let open = null;

/** Open the guide for `ctx` (defaults to this browser's). `from` gets focus back. */
export function openInstallGuide(ctx = installContext(), from = null) {
  if (open) open.close();
  const data = stepsFor(ctx === "prompt" || ctx === "installed" ? "android-manual" : ctx);
  const titleId = "ig-title-" + Math.random().toString(36).slice(2, 8);

  const list = h("ol", { class: "ig-steps" });
  data.steps.forEach((s, i) => {
    const li = h("li", { class: "ig-step" },
      h("span", { class: "ig-num", "aria-hidden": "true" }, String(i + 1)),
      h("span", { class: "ig-glyph", "aria-hidden": "true", html: s.glyph === "app" ? APP_ICON : GLYPH[s.glyph] || "" }),
      h("span", { class: "ig-text", html: s.text }));
    const shot = shotFor(s.shot);
    if (shot) li.append(shot);
    list.append(li);
  });

  const closeBtn = h("button", { type: "button", class: "ig-close", "aria-label": "Close" },
    h("span", { "aria-hidden": "true", html: G('<path d="M6 6l12 12M18 6 6 18"/>') }));
  const dialog = h("div", {
    class: "ig-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId,
  },
  h("div", { class: "ig-head" }, h("h2", { id: titleId }, data.title), closeBtn),
  h("p", { class: "ig-lead" }, data.lead),
  list);

  if (data.copy) {
    const url = location.origin + "/";
    const status = h("span", { class: "ig-copied", role: "status" });
    const copy = h("button", { type: "button", class: "ig-btn" }, "Copy link");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); status.textContent = "Copied — paste it into your browser."; }
      catch { status.textContent = url; }
    });
    dialog.append(h("div", { class: "ig-row" }, copy, status));
  }
  if (data.qr) {
    const qr = h("div", { class: "ig-qr", "aria-hidden": "true" });
    dialog.append(qr);
    import("./vendor/qrcode.js")
      .then(({ qrSvg }) => { qr.innerHTML = qrSvg(location.origin + "/", { label: "Batwa address" }); })
      .catch(() => qr.remove());
  }
  for (const line of data.foot || []) dialog.append(h("p", { class: "ig-foot", html: line }));

  const backdrop = h("div", { class: "ig-backdrop" });
  const root = h("div", { class: "ig-root" }, backdrop, dialog);
  document.body.append(root);
  const html = document.documentElement;
  const prevOverflow = html.style.overflow;
  html.style.overflow = "hidden";
  requestAnimationFrame(() => root.classList.add("is-open"));

  const focusables = () => [...dialog.querySelectorAll("button, a[href], [tabindex]:not([tabindex='-1'])")]
    .filter((n) => !n.hidden && !n.disabled);
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  function close() {
    if (!root.isConnected) return;
    document.removeEventListener("keydown", onKey, true);
    html.style.overflow = prevOverflow;
    root.classList.remove("is-open");
    const done = () => root.remove();
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) done(); else setTimeout(done, 220);
    open = null;
    try { from && from.focus(); } catch {}
  }

  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("click", close);
  closeBtn.addEventListener("click", close);
  closeBtn.focus();
  open = { close };
  return open;
}
