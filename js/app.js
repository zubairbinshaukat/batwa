// Batwa entry point: boot sequence, routing, SW registration, install flow.

import { openDB, ensureSchema, getMeta, setMeta } from "./db.js";
import {
  hasPin, hasDeviceKey, isFirstRun, unlockWithDeviceKey, unlockWithSession,
  showSetup, showLock, showOnboarding, showAccountsStep, initAutoLock,
} from "./auth.js";
import { loadLedger, onChange, state } from "./ledger.js";
import { scheduleSync, syncNow, getSyncState, onSyncState } from "./sync.js";
import { $, el, anim } from "./util/dom.js";
import { renderHome } from "./ui/home.js";
import { renderReports } from "./ui/reports.js";
import { renderHistory } from "./ui/history.js";
import { renderSettings } from "./ui/settings.js";
import { addMoneySheet, addExpenseSheet, quickAddSheet, sheetOpen } from "./ui/modals.js";
import { toast } from "./ui/toast.js";
import { icon } from "./ui/icons.js";
import { mountBackupNudge } from "./nudge.js";
import { parseTransactionSms, matchAccount, prefillTitle } from "./smsparse.js";
import { LOGO_KINDS } from "./ui/accounts.js";
import { isoDate } from "./util/format.js";

/* ============================================================
   Views + nav
   ============================================================ */

const VIEWS = {
  home: { label: "Home", render: renderHome,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/></svg>' },
  reports: { label: "Reports", render: renderReports,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>' },
  history: { label: "History", render: renderHistory,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' },
  settings: { label: "Settings", render: renderSettings,
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' },
};

let currentView = "home";
let unlocked = false;

// FAB sits between the 2nd and 3rd nav item — "home, reports, [+], history, settings".
const FAB_AFTER_INDEX = 1;

function renderNav() {
  const nav = $("#nav");
  nav.innerHTML = "";
  Object.entries(VIEWS).forEach(([key, v], i) => {
    const b = el("button", {
      class: `nav-item ${key === currentView ? "is-active" : ""}`,
      "aria-label": v.label,
      "aria-current": key === currentView ? "page" : false,
      onclick: () => go(key),
    });
    b.innerHTML = `${v.icon}<span>${v.label}</span><span class="nav-ind"></span>`;
    nav.append(b);
    if (i === FAB_AFTER_INDEX) nav.append(fabSlot());
  });
}

function fabSlot() {
  const slot = el("div", { class: "nav-fab-slot" });
  const fab = el("button", {
    class: "nav-fab", "aria-label": "Quick add",
    onclick: () => { if (!sheetOpen()) quickAddSheet("expense"); },
    html: icon("plus", 24),
  });
  slot.append(fab);
  return slot;
}

export function go(view) {
  if (view === currentView && unlocked) return;
  currentView = view;
  history.replaceState({ view }, "");
  renderNav();
  renderView();
  // each tab starts at the top — never inherit the previous tab's scroll
  window.scrollTo(0, 0);
}

function renderView() {
  if (!unlocked) return;
  const viewEl = $("#view");
  try {
    VIEWS[currentView].render(viewEl);
    if (currentView === "home") mountHomeBanners();
  } catch (err) {
    console.error(err);
    viewEl.innerHTML = `
      <div class="empty"><div class="empty-ico">${icon("frown", 26)}</div>
      <h3>Something went wrong</h3>
      <p>${String(err.message || err)}</p></div>`;
  }
}

// re-render on any data change + queue a sync
onChange(() => { renderView(); scheduleSync(); updateSyncPill(); });

/* ============================================================
   Sync status pill (right of the greeting)
   ============================================================ */

const PILL_ICONS = {
  off:     icon("circle-dash", 13),
  offline: icon("zap", 13),
  syncing: `<span class="spin">${icon("refresh", 13)}</span>`,
  pending: icon("dot", 13),
  synced:  icon("check", 13),
};

async function updateSyncPill() {
  const pill = $("#sync-pill");
  if (!pill) return;
  const s = await getSyncState();
  pill.className = `sync-pill st-${s.state}`;
  pill.innerHTML = `${PILL_ICONS[s.state] || ""}<span>${s.text}</span>`;
  pill.onclick = () => {
    if (s.state === "off") { go("settings"); return; }
    syncNow();
  };
}

onSyncState(updateSyncPill);
window.addEventListener("online", updateSyncPill);
window.addEventListener("offline", updateSyncPill);
setInterval(updateSyncPill, 60000); // keep "Synced X min ago" fresh

/* ============================================================
   Install experience
   ============================================================ */

let deferredPrompt = null;

const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

export function getInstallState() {
  if (isStandalone()) return "standalone";
  if (deferredPrompt) return "installable";
  if (isIOS()) return "ios";
  return "browser";
}

export async function promptInstall() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === "accepted") { deferredPrompt = null; toast("Batwa installed", { icon: icon("check-circle", 18) }); }
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (unlocked && currentView === "home") mountHomeBanners();
});

// One banner at a time: install wins, the backup nudge takes what's left.
async function mountHomeBanners() {
  const showingInstall = await mountInstallBanner();
  await mountBackupNudge($("#nudge-slot"), { installShowing: showingInstall });
}

/** Returns true when the install banner is on screen. */
async function mountInstallBanner() {
  const slot = $("#install-slot");
  if (!slot || isStandalone()) return false;
  if (await getMeta("installDismissed")) return false;
  const state = getInstallState();
  if (state !== "installable" && state !== "ios") return false;
  slot.innerHTML = "";
  const banner = el("div", { class: "install-banner" });
  banner.innerHTML = `
    <span class="ib-ico" style="color:#fff">${icon("smartphone", 20)}</span>
    <span class="grow"><strong>Put Batwa on your home screen</strong>
    <p>${state === "ios" ? "Share → Add to Home Screen in Safari" : "Installs like an app, works fully offline"}</p></span>
  `;
  if (state === "installable") {
    banner.append(el("button", { class: "btn btn-sm", style: "background:#fff;color:var(--c-ink);flex:0 0 auto", onclick: promptInstall }, "Install"));
  }
  banner.append(el("button", {
    class: "icon-btn", style: "background:transparent;border:none;box-shadow:none;color:rgba(255,255,255,0.6);width:36px;height:36px;flex:0 0 auto",
    "aria-label": "Dismiss",
    html: icon("x", 16),
    onclick: async () => { await setMeta("installDismissed", true); banner.remove(); },
  }));
  slot.append(banner);
  anim(banner, { y: -14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: "power2.out" });
  return true;
}

/* ============================================================
   Shared bank SMS (manifest share_target)
   ============================================================ */

/**
 * The share payload, or null when this is an ordinary launch. Android puts the
 * SMS body in `text`; `url` and `title` are usually empty but are joined in
 * when present. `share=1` is what marks the launch — the body can be blank.
 */
function readSharedPayload() {
  let q;
  try { q = new URLSearchParams(location.search); } catch { return null; }
  if (q.get("share") == null) return null;
  const parts = [q.get("text"), q.get("url"), q.get("title")].filter(Boolean);
  return parts.join("\n");
}

/** Parse the message and open the matching sheet, pre-filled and fully editable. */
async function openSharedSheet(text) {
  const note = String(text || "").slice(0, 300);
  const parsed = parseTransactionSms(text);

  if (!text || parsed.rejected) {
    addExpenseSheet(null, { prefill: { note } });
    const why = parsed.rejected === "reversal" ? "That's a reversal — nothing to add"
      : parsed.rejected === "otp" ? "That message isn't a payment"
        : "Couldn't read that message — fill it in yourself";
    toast(why, { icon: icon("alert", 18) });
    return;
  }

  let memory = {};
  try { memory = (await getMeta("shareAccountMemory")) || {}; } catch {}
  const providerName = parsed.providerKind ? LOGO_KINDS[parsed.providerKind]?.name : null;
  const guess = parsed.categoryGuess;
  const prefill = {
    amount: parsed.amount ?? undefined,
    title: prefillTitle(parsed, providerName),
    date: parsed.date || isoDate(),
    category: guess && state.categories.includes(guess) ? guess : "Others",
    accountId: matchAccount(parsed, state.accounts, memory),
    providerKind: parsed.providerKind,
    note,
  };

  if (parsed.direction === "credit") addMoneySheet(null, { prefill });
  else addExpenseSheet(null, { prefill });
  if (parsed.amount == null) toast("Couldn't read an amount — type it in", { icon: icon("alert", 18) });
}

/* ============================================================
   Service worker + update toast
   ============================================================ */

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    // A new SW is waiting: offer reload, never silently update mid-session.
    function watch(worker) {
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdateToast(worker);
        }
      });
    }
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
    reg.addEventListener("updatefound", () => reg.installing && watch(reg.installing));
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  } catch (err) {
    console.warn("SW registration failed", err);
  }
}

function showUpdateToast(worker) {
  const slot = $("#update-slot");
  if (!slot) return;
  slot.innerHTML = "";
  const banner = el("div", { class: "install-banner" });
  banner.innerHTML = `
    <span class="ib-ico" style="color:#fff">${icon("sparkles", 20)}</span>
    <span class="grow"><strong>Update available</strong>
    <p>Restart Batwa to get the latest version — a tap does it, no browser reload needed</p></span>
  `;
  banner.append(el("button", {
    class: "btn btn-sm", style: "background:#fff;color:var(--c-ink);flex:0 0 auto",
    onclick: () => worker.postMessage("SKIP_WAITING"),
  }, "Reload"));
  slot.append(banner);
  anim(banner, { y: -14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: "power2.out" });
}

/* ============================================================
   Offline indicator
   ============================================================ */

function initOnlineState() {
  const set = () => document.body.classList.toggle("is-offline", !navigator.onLine);
  window.addEventListener("online", set);
  window.addEventListener("offline", set);
  set();
  // catch up whenever the app comes back to the foreground
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { scheduleSync(); updateSyncPill(); }
  });
}

/* ============================================================
   Boot
   ============================================================ */

/**
 * Get a key, then paint the app.
 *   pin      -> keypad, exactly as before
 *   device   -> no-PIN mode: straight in, no lock screen ever
 *   first run-> welcome + security choice, then the accounts step over home
 * Anything else (a blob with no key meta) falls back to the legacy PIN setup.
 */
async function unlockFlow() {
  unlocked = false;
  let firstRun = false;
  // a refresh (or the SW's own reload) must not re-ask for the PIN
  if (await hasPin()) { if (!(await unlockWithSession())) await showLock(); }
  else if (await hasDeviceKey()) await unlockWithDeviceKey();
  else if (await isFirstRun()) { firstRun = true; await showOnboarding(); }
  else await showSetup();
  await loadLedger();
  unlocked = true;
  renderNav();
  renderView();
  updateSyncPill();
  if (firstRun) await showAccountsStep(); // sits over the freshly rendered home
  syncNow({ silent: true });
}

async function boot() {
  try {
    await openDB();
    await ensureSchema();
    initOnlineState();
    registerSW();
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    history.replaceState({ view: "home" }, "");

    // Consumed once, and the query goes before the lock screen does — a reload
    // must never re-open the sheet.
    const shared = readSharedPayload();
    if (shared !== null) history.replaceState({ view: "home" }, "", "./");

    await unlockFlow();

    initAutoLock(() => unlockFlow());

    // PWA shortcut deep links (long-press icon)
    const action = new URLSearchParams(location.search).get("action");
    if (action === "add-expense") addExpenseSheet();
    if (action === "add-money") addMoneySheet();
    if (action) history.replaceState({ view: "home" }, "", "./");

    if (shared !== null) await openSharedSheet(shared);
  } catch (err) {
    console.error(err);
    $("#view").innerHTML = `
      <div class="empty"><div class="empty-ico">${icon("frown", 26)}</div>
      <h3>Batwa couldn't start</h3>
      <p>${String(err.message || err)}. Try reloading — your data is safe.</p></div>`;
  }
}

// No unhandled error ever lands on a blank screen.
window.addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
  toast("Something went wrong — nothing was lost", { icon: icon("alert", 18) });
});

boot();
