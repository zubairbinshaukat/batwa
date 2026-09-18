// Batwa entry point: boot sequence, routing, SW registration, install flow.

import { openDB, ensureSchema, getMeta, setMeta } from "./db.js";
import { relayHost, relayUrl } from "./config.js";
import {
  hasPin, hasDeviceKey, isFirstRun, unlockWithDeviceKey, unlockWithSession,
  showSetup, showLock, showOnboarding, showAccountsStep, initAutoLock,
} from "./auth.js";
import { loadLedger, onChange, state } from "./ledger.js";
import { scheduleSync, syncNow, getSyncState, onSyncState } from "./sync.js";
import { $, el, anim } from "./util/dom.js";
import { renderHome, paintSpacesSlot } from "./ui/home.js";
import { renderReports } from "./ui/reports.js";
import { renderHistory } from "./ui/history.js";
import { renderSettings } from "./ui/settings.js";
import { addMoneySheet, addExpenseSheet, quickAddSheet, sheetOpen, closeSheet } from "./ui/modals.js";
import { toast } from "./ui/toast.js";
import { icon } from "./ui/icons.js";
import { mountBackupNudge } from "./nudge.js";
import { parseTransactionSms, matchAccount, prefillTitle } from "./smsparse.js";
import { LOGO_KINDS } from "./ui/accounts.js";
import { isoDate, greeting } from "./util/format.js";
import { initTheme, resolvedTheme, setThemeMode, onThemeChange } from "./theme.js";
import { initDock, expandDock } from "./ui/dock.js";
import {
  initSpaces, onSpacesChange, hasSpaces, anyPending, anyTrouble, getSpace,
  pullSpace, pendingForMe, resubscribeSpacePush, spacesReady,
  anyQueued, takeRemovedNotice,
} from "./spaces.js";
import { installPushMessageHandlers } from "./ui/pushsetup.js";
import { pendingSheet } from "./ui/pendingcard.js";
import { renderSpace, setSpaceTarget, spaceTarget } from "./ui/spaceview.js";
import { spacesSwitcherSheet, openJoinFromLink } from "./ui/spaces.js";

/* ============================================================
   Views + nav
   ============================================================ */

const VIEWS = {
  home:     { label: "Home",     render: renderHome,     iconName: "home" },
  reports:  { label: "Reports",  render: renderReports,  iconName: "bar-chart" },
  history:  { label: "History",  render: renderHistory,  iconName: "clock" },
  settings: { label: "Settings", render: renderSettings, iconName: "settings" },
  // A view with no dock item: reached only through go("space", { id }), so the
  // dock shows nothing active while it is open (plan §4.5).
  space:    { label: "Space",    render: renderSpace,    iconName: null, offDock: true },
};

let currentView = "home";
/** Route params for views that take one — today only `space`'s `{ id }`. */
let currentParams = null;
let unlocked = false;

// FAB sits between the 2nd and 3rd nav item — "home, reports, [+], history, settings".
const FAB_AFTER_INDEX = 1;

function renderNav() {
  const nav = $("#nav");
  nav.innerHTML = "";
  Object.entries(VIEWS).filter(([, v]) => !v.offDock).forEach(([key, v], i) => {
    const b = el("button", {
      class: `nav-item ${key === currentView ? "is-active" : ""}`,
      "aria-label": v.label,
      "aria-current": key === currentView ? "page" : false,
      onclick: () => go(key),
    });
    b.innerHTML = `<span class="nav-pebble"></span>${
      icon(key === currentView ? `${v.iconName}-fill` : v.iconName, 22)
    }<span class="lbl">${v.label}</span>`;
    nav.append(b);
    if (i === FAB_AFTER_INDEX) nav.append(fabSlot());
  });
}

function fabSlot() {
  return el("button", {
    class: "nav-fab", "aria-label": "Quick add",
    onclick: () => { if (!sheetOpen()) quickAddSheet("expense"); },
    html: icon("plus", 22),
  });
}

/**
 * Navigate. `params` is for views that take one (`go("space", { id })`).
 *
 * Tabs replace the history entry, exactly as before; the space view PUSHES one,
 * so hardware back and the canopy chevron both walk out of a space instead of
 * closing the app. Sheets push their own entry on top of whichever this is.
 */
export function go(view, params = null) {
  if (!VIEWS[view]) return;
  const sameParams = (params?.id || null) === (currentParams?.id || null);
  if (view === currentView && sameParams && unlocked) return;
  const from = currentView;
  currentView = view;
  currentParams = params;
  if (view === "space") {
    setSpaceTarget(params?.id);
    if (from !== "space") history.pushState({ view, params }, "");
    else history.replaceState({ view, params }, "");
  } else {
    history.replaceState({ view, params }, "");
  }
  renderNav();
  renderView();
  // each tab starts at the top — never inherit the previous tab's scroll
  window.scrollTo(0, 0);
  expandDock();
}

/** The space canopy's back chevron, and Escape while a space is open. */
export function goBackFromSpace() {
  if (currentView !== "space") return;
  if (history.state && history.state.view === "space") { history.back(); return; }
  go("home");
}

/**
 * Hardware/browser back. The sheet layer owns its own entries (modals.js pushes
 * `batwaSheet` and pops it on close), so this only acts on view entries.
 */
window.addEventListener("popstate", (e) => {
  const st = e.state || {};
  if (st.batwaSheet || sheetOpen()) return;
  const view = VIEWS[st.view] ? st.view : "home";
  const params = st.params || null;
  if (view === currentView && (params?.id || null) === (currentParams?.id || null)) return;
  currentView = view;
  currentParams = params;
  if (view === "space") setSpaceTarget(params?.id);
  renderNav();
  renderView();
  window.scrollTo(0, 0);
  expandDock();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && currentView === "space" && !sheetOpen()) goBackFromSpace();
});

function renderView() {
  if (!unlocked) return;
  const viewEl = $("#view");
  // The canopy belongs to the page, not to one tab: reset it here, because
  // onChange() and unlockFlow() come through this function too, not only go().
  document.body.dataset.view = currentView;
  const slot = $("#canopy-slot");
  if (slot) slot.innerHTML = "";
  $("#canopy")?.classList.remove("is-negative");
  const hello = $("#hello");
  if (hello) hello.textContent = greeting();
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

/**
 * Re-render on any data change + queue a sync. A `{ silent: true }` emit means
 * the surface that made the change already repainted itself (background space
 * pulls, inline accept cards) — those only refresh the chrome, so an open sheet
 * or a half-scrolled list is never yanked out from under the user.
 */
onChange(({ silent = false } = {}) => {
  if (silent) { updateSyncPill(); refreshBadges(); return; }
  renderView();
  scheduleSync();
  updateSyncPill();
  refreshBadges();
});

/**
 * Header badges and dots that live outside the current view (the shared-spaces
 * dot lands here in M2). A no-op today; the hook exists so silent emits already
 * have the one place they are meant to call.
 */
export function refreshBadges() {
  // Home's shared-requests card is chrome too: a proposal arriving in the
  // background has to show up there without a renderView() (plan §5.3, §9.29).
  if (unlocked && currentView === "home") { try { paintSpacesSlot(); } catch (err) { console.warn(err); } }
  const b = $("#spaces-btn");
  if (!b) return;
  const on = hasSpaces();
  b.classList.toggle("hidden", !on);
  if (!on) return;
  b.innerHTML = icon("users", 19);
  const pending = anyPending();
  b.classList.toggle("has-pending", pending);
  // Amber, not violet: the relay is out of reach or a write is still queued,
  // so what is on screen is the last copy and the phone knows it (plan 9.3).
  const trouble = anyTrouble() || anyQueued();
  b.classList.toggle("has-trouble", !pending && trouble);
  b.setAttribute("aria-label", pending
    ? "Shared spaces \u2014 something is waiting for you"
    : trouble ? "Shared spaces \u2014 not synced yet" : "Shared spaces");
}

/** Wire the header button once; visibility is re-evaluated on every change. */
function initSpacesButton() {
  const b = $("#spaces-btn");
  if (!b) return;
  b.addEventListener("click", () => { if (!sheetOpen()) spacesSwitcherSheet(); });
  refreshBadges();
}

// A background pull never re-renders the page: it refreshes the chrome, and
// repaints the space view only when that space is the one on screen (§9.29).
onSpacesChange(({ id, reason }) => {
  refreshBadges();
  spaceNotice(id, reason);
  if (currentView !== "space") return;
  if (id && id !== spaceTarget()) return;
  if (!getSpace(spaceTarget())) { go("settings"); return; }
  renderView();
});

/**
 * The three things a background space event has to SAY rather than just draw.
 * Each is once per event and never interrupts: a toast, never a dialog.
 *   push-failed  five merges lost to a busy space (§9.2)
 *   too-large    the blob will not fit through the relay any more (§9.4)
 *   removed      somebody deleted an entry I was still holding (§9.8)
 */
let lastNoticeAt = 0;
function spaceNotice(id, reason) {
  if (!["push-failed", "too-large", "removed"].includes(reason)) return;
  const name = getSpace(id)?.name || "that space";
  const now = Date.now();
  if (now - lastNoticeAt < 2000) return;
  lastNoticeAt = now;
  if (reason === "push-failed") {
    toast(`Couldn't sync ${name} yet \u2014 Batwa will keep trying`, { icon: icon("alert", 18) });
  } else if (reason === "too-large") {
    toast(`${name} is too big to sync \u2014 compact its older history`, { icon: icon("archive", 18) });
  } else {
    const gone = takeRemovedNotice();
    if (gone) toast(`${gone.by} removed ${gone.title}`, { icon: icon("trash", 18) });
  }
}

/* ============================================================
   Notifications: what a tapped banner opens (plan §7.3, §9.27, §9.28)
   ============================================================ */

/** A url the worker sent while the app was still locked. Applied after unlock. */
let deferredOpen = null;

/**
 * `?open=pending&space=<id>`: the pending sheet for that space. If nothing is
 * pending any more — someone else answered it, or I did on my other phone —
 * the space itself opens instead, with one line saying why (§9.28).
 */
async function openPendingFromLink(spaceId) {
  const id = spaceId || null;
  // The cached blobs come back a tick after unlock; deciding before they do
  // would call everything "nothing pending".
  await Promise.race([spacesReady(), new Promise((r) => setTimeout(r, 4000))]);
  if (id && getSpace(id) && !pendingForMe(id).length) {
    go("space", { id });
    toast("Nothing pending here", { icon: icon("check-circle", 18) });
    return;
  }
  const wasOpen = sheetOpen();
  if (wasOpen) closeSheet();
  setTimeout(() => pendingSheet(id), wasOpen ? 260 : 0);
}

/**
 * One place that turns a notification url into a screen, whether it arrived in
 * `location.search` on a cold start or as a `{ type: "open" }` message from the
 * worker. A locked app remembers it and opens it the moment the PIN lands.
 */
function handleOpenUrl(url) {
  let q;
  try { q = new URL(String(url || "./"), location.href).searchParams; } catch { return; }
  if (!unlocked) { deferredOpen = String(url || "./"); return; }
  if (q.get("open") === "pending") openPendingFromLink(q.get("space"));
  else if (q.get("join")) openJoinFromLink(q.get("join"));
}

/** The worker's three messages, wired once (js/ui/pushsetup.js). */
function initPushMessages() {
  installPushMessageHandlers({
    // A push landed: pull that space quietly. The ledger emits silently, so
    // the page underneath never re-renders (§9.29).
    onSpacesChanged: (id) => { if (id) pullSpace(id).catch(() => {}); },
    onOpen: (url) => handleOpenUrl(url),
    onResubscribe: () => { resubscribeSpacePush().catch(() => {}); },
  });
}

/* ============================================================
   Theme toggle (header) — one tap flips light <-> dark. Settings keeps the
   three-way choice, including "follow system"; this just flips away from
   whatever is on screen right now.
   ============================================================ */

function paintThemeToggle() {
  const b = $("#theme-toggle");
  if (!b) return;
  const dark = resolvedTheme() === "dark";
  b.innerHTML = icon(dark ? "sun" : "moon", 19);
  b.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
}

function initThemeToggle() {
  const b = $("#theme-toggle");
  if (!b) return;
  paintThemeToggle();
  onThemeChange(paintThemeToggle);
  b.addEventListener("click", () => {
    setThemeMode(resolvedTheme() === "dark" ? "light" : "dark");
  });
}

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
    sendConfig(reg);
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

/**
 * Hand the worker the one config value it needs and cannot import: the relay
 * hostname, so its fetch handler can go network-only for it the way it already
 * does for jsonbin.io. Null when shared spaces are off.
 */
function sendConfig(reg) {
  const post = (w) => {
    try { w?.postMessage({ type: "config", relayHost: relayHost(), relayBase: relayUrl() || null }); } catch {}
  };
  post(reg.active || navigator.serviceWorker.controller);
  // A first-ever install has no active worker yet — catch it once it's ready.
  navigator.serviceWorker.ready.then((r) => post(r.active)).catch(() => {});
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
  const set = () => {
    document.body.classList.toggle("is-offline", !navigator.onLine);
    refreshBadges();
  };
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
  initSpacesButton();
  if (firstRun) await showAccountsStep(); // sits over the freshly rendered home
  syncNow({ silent: true });
  initSpaces();
  // A notification tapped while locked waits for the PIN, then opens (§9.27).
  if (deferredOpen) {
    const url = deferredOpen;
    deferredOpen = null;
    setTimeout(() => handleOpenUrl(url), 320);
  }
}

async function boot() {
  try {
    initTheme();   // the inline boot script already painted it; this keeps it live
    initThemeToggle();
    await openDB();
    await ensureSchema();
    initOnlineState();
    registerSW();
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    initDock();
    initPushMessages();
    history.replaceState({ view: "home" }, "");

    // Consumed once, and the query goes before the lock screen does — a reload
    // must never re-open the sheet.
    const shared = readSharedPayload();
    if (shared !== null) history.replaceState({ view: "home" }, "", "./");

    await unlockFlow();

    initAutoLock(() => unlockFlow());

    // PWA shortcut deep links (long-press icon)
    const query = new URLSearchParams(location.search);
    const action = query.get("action");
    if (action === "add-expense") addExpenseSheet();
    if (action === "add-money") addMoneySheet();
    if (action) history.replaceState({ view: "home" }, "", "./");

    // ?join=<invite> — the same after-unlock, scrub-the-URL pattern as ?action=
    const join = query.get("join");
    if (join) {
      history.replaceState({ view: "home" }, "", "./");
      openJoinFromLink(join);
    }

    // ?open=pending&space=<id> — a tapped notification on a cold start
    const open = query.get("open");
    if (open) {
      history.replaceState({ view: "home" }, "", "./");
      if (open === "pending") openPendingFromLink(query.get("space"));
    }

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
