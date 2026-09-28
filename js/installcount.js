// The install counter's one ping (relay/src/stats.js).
//
// Sent once per install, the first time Batwa runs as an installed app — or,
// on Android, the moment Chrome says it was installed. What leaves the phone:
//
//   { p: "android" | "ios" | "other", n: "<random one-time nonce>" }
//
// Nothing else: no user agent, no time, no id, nothing about money. The nonce
// makes a retry idempotent (a lost response must not count twice) and the
// relay forgets it within a week.
//
// It is NEVER sent from the service worker's `install` event: that fires on
// every app update and in plain browser tabs. The "already counted" flag lives
// in IndexedDB (mirrored in localStorage), which an update or a reload never
// touches — so the counter goes up once per install, not once per release.
// Existing installs are each counted once, on their first open after this
// shipped.
//
// What it cannot know: an uninstall (the web has no such event), and "clear
// site data" or uninstall-then-reinstall counts again. It is a count of
// installs, best effort against deliberate inflation, not a census.

import { getMeta, setMeta, dbDel } from "./db.js";
import { relayUrl } from "./config.js";

const FLAG = "installCounted";
const NONCE = "installNonce";
const LS_FLAG = "batwa.installCounted";

let inFlight = null;

/** Running as the installed app, not a browser tab. */
export function isInstalledApp() {
  try {
    return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  } catch { return false; }
}

/** "android" | "ios" | "other". iPadOS says "Macintosh", so touch decides. */
export function platformWord() {
  const ua = String(navigator.userAgent || "");
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Macintosh/.test(ua) && Number(navigator.maxTouchPoints) > 1) return "ios";
  if (/Android/.test(ua)) return "android";
  return "other";
}

/** 24 url-safe characters of randomness — the shape the relay accepts. */
function newNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function alreadyCounted() {
  try { if (localStorage.getItem(LS_FLAG) === "1") return true; } catch {}
  try { return !!(await getMeta(FLAG)); } catch { return false; }
}

async function markCounted() {
  try { localStorage.setItem(LS_FLAG, "1"); } catch {}
  try { await setMeta(FLAG, true); } catch {}
  try { await dbDel("meta", NONCE); } catch {}
}

/**
 * Count this install if it has not been counted. Cheap no-op afterwards.
 *
 * `reason: "launch"` (every start) only counts inside the installed app.
 * `reason: "appinstalled"` (Android Chrome/Edge/Samsung) counts at once: there
 * the browser tab and the installed app share storage, so the flag set here
 * stops the first launch from counting again. iOS gives the home-screen app
 * storage of its own, which is why iOS only ever counts on launch.
 *
 * Never throws and never blocks: a failure is retried on the next start and
 * on the next `online` event, with the same nonce.
 */
export function countInstallOnce({ reason = "launch" } = {}) {
  // The cheap refusals stay synchronous: an async body that returns before its
  // first await would run its cleanup before `inFlight` was even assigned.
  const base = relayUrl();
  if (!base) return Promise.resolve(false);
  if (reason === "launch" && !isInstalledApp()) return Promise.resolve(false);
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      if (await alreadyCounted()) return false;

      let nonce = null;
      try { nonce = await getMeta(NONCE); } catch {}
      if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
        nonce = newNonce();
        try { await setMeta(NONCE, nonce); } catch {}
      }

      // text/plain keeps this a "simple" request: no CORS preflight, one trip.
      const res = await fetch(String(base).replace(/\/+$/, "") + "/v1/install", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ p: platformWord(), n: nonce }),
        keepalive: true,
        cache: "no-store",
        credentials: "omit",
      });
      if (!res.ok) return false;
      await markCounted();
      return true;
    } catch {
      return false; // offline, relay down: next start or next `online` retries
    }
  })();
  inFlight = run;
  run.finally(() => { if (inFlight === run) inFlight = null; });
  return run;
}

/**
 * Wire it up once, from app boot: an idle-time attempt now, and another
 * whenever the network comes back.
 */
export function initInstallCount() {
  const later = (fn) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 5000 });
    else setTimeout(fn, 2000);
  };
  later(() => countInstallOnce({ reason: "launch" }));
  window.addEventListener("online", () => countInstallOnce({ reason: "launch" }));
  // `appinstalled` is wired in js/installguide.js, which both pages load.
}
