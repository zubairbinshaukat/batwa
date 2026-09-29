// Screens and sheets that Home doesn't need, loaded on demand.
//
// Home is the first thing anyone sees, so only the code Home uses is on the
// start-up path. Everything else (Reports, History, Settings, the space view,
// the add/edit forms, the spaces sheets) is split out by the bundler and loaded
// through the named loaders below, and prefetchAll() pulls all of it in the
// background right after Home first paints, so by the time a finger reaches a
// tab it is already here. The service worker precaches every one of these
// chunks too (build/vite-plugin-sw.js), so offline behaves the same.
//
// Every dynamic import() of these modules goes through this file. A static
// import of one of them from the start-up path would quietly fold it back into
// the main bundle; vite.config.js turns on the check that warns about that.

import { toast } from "./toast.js";
import { icon } from "./icons.js";

const IMPORTERS = {
  modals: () => import("./modals.js"),
  reports: () => import("./reports.js"),
  history: () => import("./history.js"),
  settings: () => import("./settings.js"),
  spaceview: () => import("./spaceview.js"),
  // js/ui/spaces.js: the spaces sheets (switcher, join, invite), not the
  // data layer in js/spaces.js, which is on the start-up path.
  spacesUI: () => import("./spaces.js"),
  pendingcard: () => import("./pendingcard.js"),
};

const fetching = new Map(); // name -> promise of the module, shared with prefetchAll()
const loading = new Map();  // name -> the promise load[name]() hands out
const ready = new Map();    // name -> the module, once it has arrived

/**
 * One import() per module, however many callers ask. A rejected promise is
 * forgotten so the next call asks again; Safari and Firefox do fetch again,
 * but Chromium remembers a failed module for the life of the page, so there
 * the Reload offered below is the way back (renderView paints it in place of
 * the screen too, so a failed tab is never just blank).
 */
function fetchModule(name) {
  let p = fetching.get(name);
  if (!p) {
    p = IMPORTERS[name]().then(
      (mod) => { ready.set(name, mod); return mod; },
      (err) => { fetching.delete(name); throw err; },
    );
    fetching.set(name, p);
  }
  return p;
}

/*
 * A chunk that fails to DOWNLOAD is a tab left open across a deploy (the file
 * name no longer exists and no service worker has it) or a network blip on a
 * first visit. Nothing is wrong with the data, so say so once and offer the
 * reload, but never reload by itself: the user may be half-way through a form.
 *
 * Only download failures get this treatment. A module that downloads fine but
 * throws while it starts is a real bug: it is left alone, so it reaches the
 * usual "Something went wrong" path instead of hiding behind a reload prompt.
 */
const FAILED = "batwaLoadFailed";
const FETCH_FAILURE = /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch|NetworkError|Load failed/i;

/** True when `err` is the browser saying a module file could not be fetched. */
export function isFetchFailure(err) {
  return FETCH_FAILURE.test(String((err && err.message) || err || ""));
}

let lastNotice = 0;
function notifyFailure(err) {
  if (!isFetchFailure(err)) return; // a real error: let it surface as one
  console.warn(err);
  try { if (err && typeof err === "object") err[FAILED] = true; } catch {}
  const now = Date.now();
  if (now - lastNotice < 4000) return; // several loaders failing together: one toast
  lastNotice = now;
  toast("Part of Batwa didn't load — tap Reload", {
    icon: icon("refresh", 18),
    action: { label: "Reload", onClick: () => location.reload() },
  });
}

/** True for a rejection load.x() already told the user about (app.js's unhandledrejection). */
export function isLoadFailure(err) {
  return !!(err && typeof err === "object" && err[FAILED]);
}

/**
 * Named loaders, memoised: `await load.reports()` is the module, and the same
 * promise every time. On failure it rejects after showing the reload toast, so
 * callers only have to stop what they were doing.
 */
export const load = {};
for (const name of Object.keys(IMPORTERS)) {
  load[name] = () => {
    let p = loading.get(name);
    if (!p) {
      p = fetchModule(name).catch((err) => {
        loading.delete(name);
        notifyFailure(err);
        throw err;
      });
      loading.set(name, p);
    }
    return p;
  };
}

/** The module if it has already arrived, else null. Never starts a load. */
export function loaded(name) {
  return ready.get(name) || null;
}

/**
 * Run `fn(module)`. Once the module is here (the usual case after
 * prefetchAll()) it runs synchronously, in the same tick as the tap, exactly
 * as the old static import did, so nothing can slip in between; otherwise it
 * runs as soon as the module arrives. Returns a promise of fn's result either
 * way.
 */
export function use(name, fn) {
  const mod = ready.get(name);
  if (mod) return Promise.resolve(fn(mod));
  return load[name]().then(fn);
}

let prefetched = false;
/**
 * Load every module above in the background, once, when the browser is idle.
 * Called right after Home first paints. Failures stay quiet here: nobody asked
 * for these screens yet, and the loader tries again (and speaks up) when
 * someone does.
 */
export function prefetchAll() {
  if (prefetched) return;
  prefetched = true;
  const run = () => {
    for (const name of Object.keys(IMPORTERS)) fetchModule(name).catch(() => {});
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 200);
}
