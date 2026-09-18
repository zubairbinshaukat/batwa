/* Batwa service worker — app shell cache only. Never touches user data. */
const CACHE = "batwa-v32";

/* Marketing / SEO files. They are never precached, never runtime-cached, and
   the navigate branch below lets /about.html reach the network. The app's
   cache stays the app's cache; these change on their own schedule. */
const NO_CACHE = /\/(about\.html|css\/about\.css|robots\.txt|sitemap\.xml|llms\.txt|humans\.txt|fonts\/fraunces-var\.woff2|screenshots\/(og-batwa\.png|hero-[a-z-]+\.webp|0[1-4]-[a-z]+\.webp))$/;

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/tokens.css",
  "./css/base.css",
  "./css/components.css",
  "./css/onboarding.css",
  "./fonts/outfit-var.woff2",
  "./fonts/caveat-var.woff2",
  "./js/vendor/gsap.min.js",
  "./js/vendor/qrcode.js",
  "./js/app.js",
  "./js/config.js",
  "./js/relay.js",
  "./js/db.js",
  "./js/theme.js",
  "./js/crypto.js",
  "./js/auth.js",
  "./js/biometric.js",
  "./js/session.js",
  "./js/ledger.js",
  "./js/reminders.js",
  "./js/nudge.js",
  "./js/smsparse.js",
  "./js/insights.js",
  "./js/sync.js",
  "./js/spaces.js",
  "./js/spaces/merge.js",
  "./js/spaces/crypto.js",
  "./js/spaces/notify.js",
  "./js/ui/home.js",
  "./js/ui/reveal.js",
  "./js/ui/monthsheet.js",
  "./js/ui/dock.js",
  "./js/ui/accounts.js",
  "./js/ui/icons.js",
  "./js/ui/reports.js",
  "./js/ui/history.js",
  "./js/ui/settings.js",
  "./js/ui/spaces.js",
  "./js/ui/spaceview.js",
  "./js/ui/modals.js",
  "./js/ui/catedit.js",
  "./js/ui/pendingcard.js",
  "./js/ui/pushsetup.js",
  "./js/ui/charts.js",
  "./js/ui/toast.js",
  "./js/util/format.js",
  "./js/util/category.js",
  "./js/util/dom.js",
  "./js/util/expr.js",
  "./icons/favicon.svg",
  "./icons/icon-192-v2.png",
  "./icons/icon-512-v2.png",
  "./icons/icon-maskable-192-v2.png",
  "./icons/icon-maskable-512-v2.png",
  "./icons/apple-touch-icon-180-v2.png",
  "./icons/shortcut-expense-192.png",
  "./icons/shortcut-money-192.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  // The update toast still posts the bare string — keep that working.
  if (e.data === "SKIP_WAITING") { self.skipWaiting(); return; }
  if (e.data && e.data.type === "config") {
    // js/config.js can't be imported here (classic worker), so the page hands
    // over just the relay hostname on registration. Stored in meta so the
    // bypass below survives a worker restart with no page open.
    e.waitUntil(setRelayHost(e.data.relayHost || null, e.data.relayBase || null));
  }
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Sync API: network only, never cached.
  if (url.hostname.includes("jsonbin.io")) return;

  // Shared-spaces relay: same deal. The hostname comes from meta `relayHost`,
  // read once and kept in a module variable (the fetch handler can't await).
  if (relayHost === undefined) loadRelayHost();
  else if (relayHost && url.hostname === relayHost) return;

  if (e.request.method !== "GET") return;

  // Navigations: cache-first shell so cold offline launches are instant.
  if (e.request.mode === "navigate") {
    // Marketing/SEO pages are network-first and never served from the app
    // shell. Offline, fall back to the shell so the user still gets the app.
    if (/\/about\.html$/.test(url.pathname)) {
      e.respondWith(fetch(e.request).catch(() => caches.match("./index.html")));
      return;
    }
    e.respondWith(
      caches.match("./index.html").then((hit) => hit || fetch(e.request))
    );
    return;
  }

  // Subresources of the about page: straight to the network, never stored.
  if (NO_CACHE.test(url.pathname)) {
    e.respondWith(fetch(e.request));
    return;
  }

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          // Runtime-cache same-origin assets that slipped past precache.
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
    )
  );
});

/* ============================================================
   Relay host — meta `relayHost`, set by the page (see js/config.js)
   ============================================================ */

/** undefined = not read yet, null = no relay configured, string = hostname. */
let relayHost;
let relayHostLoading = null;

function loadRelayHost() {
  if (relayHost !== undefined || relayHostLoading) return relayHostLoading;
  relayHostLoading = (async () => {
    let db;
    try { db = await openMetaDB(); } catch { relayHostLoading = null; return; }
    try {
      const v = await metaGet(db, "relayHost");
      relayHost = v || null;
    } catch {
      relayHostLoading = null;
    } finally {
      try { db.close(); } catch {}
    }
  })();
  return relayHostLoading;
}

async function setRelayHost(host, base) {
  relayHost = host || null;
  let db;
  try { db = await openMetaDB(); } catch { return; }
  try {
    await metaPut(db, "relayHost", relayHost);
    // The full origin, for the periodic-sync fallback's HEAD requests: the
    // fetch bypass only needs a hostname, a URL needs a scheme and a port.
    await metaPut(db, "relayBase", base || (relayHost ? "https://" + relayHost : null));
  } finally { try { db.close(); } catch {} }
}

/* ============================================================
   Bill reminders — periodic background sync
   Reads meta ONLY: dueSchedule (dates + counts), remindLastDay, remindersOn.
   The encrypted blob is never opened here, and never could be: the key
   lives in the page, not in this worker.
   ============================================================ */

const DUE_TAG = "batwa-due";

/* DUPLICATE OF js/reminders.js dueSummary() — a classic worker can't import an
   ES module. Canonical copy lives there; keep the two byte-identical. */
function dueSummary(schedule, today) {
  let overdue = 0, due = 0;
  for (const row of schedule || []) {
    if (!row || !row.date) continue;
    const n = Number(row.count) || 0;
    if (row.date < today) overdue += n;
    else if (row.date === today) due += n;
  }
  let text = "";
  if (overdue && due) text = `${overdue} overdue, ${due} due today`;
  else if (overdue) text = `${overdue} overdue bill${overdue === 1 ? "" : "s"}`;
  else if (due) text = `${due} bill${due === 1 ? "" : "s"} due today`;
  return { overdue, today: due, text };
}

/** Same database as js/db.js. Opened read-only; never upgrades the schema. */
function openMetaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("batwa", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
}

function metaGet(db, key) {
  return new Promise((resolve) => {
    try {
      const r = db.transaction("meta", "readonly").objectStore("meta").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

function metaPut(db, key, val) {
  return new Promise((resolve) => {
    try {
      const t = db.transaction("meta", "readwrite");
      t.objectStore("meta").put(val, key);
      t.oncomplete = () => resolve(true);
      t.onerror = () => resolve(false);
      t.onabort = () => resolve(false);
    } catch { resolve(false); }
  });
}

function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function checkDue() {
  let db;
  try { db = await openMetaDB(); } catch { return; }
  try {
    if (!(await metaGet(db, "remindersOn"))) return;
    const today = localToday();
    if ((await metaGet(db, "remindLastDay")) === today) return; // at most one a day
    const schedule = await metaGet(db, "dueSchedule");
    const { text } = dueSummary(schedule, today);
    if (!text) return;
    // Permission can be revoked behind our back — showNotification just rejects.
    await self.registration.showNotification("Batwa", {
      body: text,
      tag: DUE_TAG,
      icon: "icons/icon-192-v2.png",
      badge: "icons/icon-maskable-192-v2.png",
      data: { url: "./" },
    });
    await metaPut(db, "remindLastDay", today);
  } catch {
    // nothing to do — a missed reminder is not worth an error
  } finally {
    try { db.close(); } catch {}
  }
}

self.addEventListener("periodicsync", (e) => {
  if (e.tag === DUE_TAG) e.waitUntil(checkDue());
  else if (e.tag === SPACES_TAG) e.waitUntil(checkSpaces());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = typeof data.url === "string" && data.url ? data.url : "./";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (!c.url.startsWith(self.location.origin)) continue;
      // The page is already running: tell it where to go rather than reloading
      // it, so an unlocked session stays unlocked (the lock screen in §9.27 is
      // the page's own business).
      try { c.postMessage({ type: "open", url }); } catch {}
      return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});

/* ============================================================
   Shared spaces - Web Push (plan 7.3)
   Reads meta ONLY: notifKeys ({ [spaceId]: base64url 32-byte key }), mirrored
   out of the encrypted bundle by js/spaces.js while "Show details" is on.
   That key can decrypt notification summaries and nothing else: not the
   ledger, not the space blob. No key, no details - just a generic banner.
   ============================================================ */

const SPACE_FALLBACK = { title: "Batwa", body: "New activity in a shared space" };

/* DUPLICATE OF js/spaces/notify.js summaryText() - a classic worker can't
   import an ES module. Canonical copy lives there; keep the two in step. */
function spaceSummaryText(summary, locale) {
  const s = summary || {};
  const who = s.by || "Someone";
  const what = s.title || "an entry";
  const where = s.space || "a shared space";
  const money = (amount) => {
    const n = Math.round(Number(amount) || 0);
    let text;
    try { text = new Intl.NumberFormat(locale || "en-PK", { maximumFractionDigits: 0 }).format(n); }
    catch { text = String(n); }
    return `Rs ${text}`;
  };
  const dot = (...parts) => parts.filter(Boolean).join(" \u00b7 ");
  const amount = Number(s.amount) || 0;
  const n = Number(s.n) || 0;
  const total = amount ? money(amount) : "";
  const share = amount && n > 1 ? money(Math.round(amount / n)) : "";
  const shareLine = share ? `Your share ${share}` : total;
  const splitLine = n > 1 ? `Split ${n} ways` : total;

  switch (s.t) {
    case "split":
      return { title: dot(`${who} split ${what}`, total), body: dot(splitLine, where) };
    case "edit":
      return { title: dot(`${who} changed ${what}`, total), body: dot(shareLine, where) };
    case "settle":
      return { title: `${who} sent ${total || "money"}`, body: dot("Settlement", where) };
    case "accept":
      return { title: `${who} accepted ${what}`, body: dot(total, where) };
    case "reject":
      return { title: `${who} rejected ${what}`, body: dot(total, where) };
    case "nudge":
      return { title: `${who} is waiting on ${what}`, body: dot(total, where) };
    case "join":
      return { title: `${who} joined ${where}`, body: n ? `${n} members now` : "Shared space" };
    case "leave":
      return { title: `${who} left ${where}`, body: n ? `${n} members now` : "Shared space" };
    default:
      return SPACE_FALLBACK;
  }
}

/* Minimal copies of the base64 helpers in js/crypto.js - same { iv, ct }
   AES-GCM layout, so what the sender's encrypt() produced opens here. */
function swUnb64(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** base64({"iv","ct"}) + the raw key -> the summary object. Throws on any miss. */
async function openSpaceSummary(rawKeyB64, payloadB64) {
  const wrapper = JSON.parse(new TextDecoder().decode(swUnb64(payloadB64)));
  if (!wrapper || typeof wrapper.iv !== "string" || typeof wrapper.ct !== "string") {
    throw new Error("bad-payload");
  }
  const key = await crypto.subtle.importKey(
    "raw", swUnb64(rawKeyB64), { name: "AES-GCM" }, false, ["decrypt"]
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: swUnb64(wrapper.iv) },
    key,
    swUnb64(wrapper.ct)
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

async function notifKeyFor(spaceId) {
  if (!spaceId) return null;
  let db;
  try { db = await openMetaDB(); } catch { return null; }
  try {
    const map = await metaGet(db, "notifKeys");
    const key = map && typeof map === "object" ? map[spaceId] : null;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

async function tellClients(message) {
  let clients = [];
  try { clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true }); }
  catch { return []; }
  for (const c of clients) {
    try { c.postMessage(message); } catch {}
  }
  return clients;
}

async function onSpacePush(raw) {
  let spaceId = null, payload = null;
  try {
    // The relay wraps our opaque base64 as { s: spaceId, p: payload }.
    const wrapper = raw ? JSON.parse(raw) : null;
    if (wrapper && typeof wrapper === "object") {
      spaceId = typeof wrapper.s === "string" ? wrapper.s : null;
      payload = typeof wrapper.p === "string" ? wrapper.p : null;
    }
  } catch {
    // not ours, or damaged - still worth waking any open page
  }

  // Always tell the pages: a background tab pulls silently instead of waiting
  // for the next poll, and a focused one makes the banner unnecessary (9.22).
  const clients = await tellClients({ type: "spaces-changed", spaceId });
  if (clients.some((c) => c.focused)) return;

  let text = SPACE_FALLBACK;
  if (spaceId && payload) {
    try {
      const rawKey = await notifKeyFor(spaceId);
      if (rawKey) text = spaceSummaryText(await openSpaceSummary(rawKey, payload));
    } catch {
      text = SPACE_FALLBACK; // details off, key rotated, wrong space - generic it is
    }
  }

  try {
    await self.registration.showNotification(text.title || SPACE_FALLBACK.title, {
      body: text.body || SPACE_FALLBACK.body,
      tag: "space-" + (spaceId || "unknown"),
      renotify: true,
      icon: "icons/icon-192-v2.png",
      badge: "icons/icon-maskable-192-v2.png",
      data: { url: "./?open=pending&space=" + encodeURIComponent(spaceId || "") },
    });
  } catch {
    // permission revoked behind our back - nothing to do
  }
}

self.addEventListener("push", (e) => {
  let raw = null;
  try { raw = e.data ? e.data.text() : null; } catch { raw = null; }
  e.waitUntil(onSpacePush(raw));
});

/* ============================================================
   Shared spaces - the no-push fallback (plan 7.3, last paragraph)
   An installed Android without a working push subscription still has
   periodicSync. Every 12h or so we HEAD each space and show the GENERIC
   banner when a version moved - never anything decrypted, because this path
   has no payload to decrypt.

   Reads meta ONLY: pushOn, spaceHeads ([{ id, token }]), relayBase,
   spaceVersions. `spaceHeads` is the one place a space token sits outside the
   PIN lock; js/spaces.js writes it only while notifications are on and deletes
   it the moment they go off, and the Settings copy says so.
   ============================================================ */

const SPACES_TAG = "batwa-spaces";

function versionFromHeaders(headers) {
  const tag = headers.get("ETag") || headers.get("X-Version");
  if (!tag) return null;
  const n = Number(String(tag).replace(/^W\//, "").replace(/"/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function checkSpaces() {
  let db;
  try { db = await openMetaDB(); } catch { return; }
  try {
    if (!(await metaGet(db, "pushOn"))) return;
    const heads = await metaGet(db, "spaceHeads");
    if (!Array.isArray(heads) || !heads.length) return;
    let base = await metaGet(db, "relayBase");
    if (!base) {
      const host = await metaGet(db, "relayHost");
      base = host ? "https://" + host : null;
    }
    if (!base) return;
    base = String(base).replace(/\/+$/, "");

    const seen = (await metaGet(db, "spaceVersions")) || {};
    const next = {};
    let changed = 0;
    for (const h of heads) {
      if (!h || !h.id || !h.token) continue;
      let version = null;
      try {
        // Network-only, never cached: the fetch handler already bypasses the
        // relay host, and no-store keeps an intermediary from answering.
        const res = await fetch(`${base}/v1/space/${encodeURIComponent(h.id)}`, {
          method: "HEAD",
          cache: "no-store",
          headers: { "X-Space-Token": h.token },
        });
        if (!res.ok) continue;
        version = versionFromHeaders(res.headers);
      } catch {
        continue; // offline, or the relay is down - try again next sync
      }
      if (version == null) continue;
      next[h.id] = version;
      if (seen[h.id] != null && version !== seen[h.id]) changed++;
    }
    await metaPut(db, "spaceVersions", { ...seen, ...next });
    if (!changed) return;

    // Same foreground rule as push (9.22): an open, focused app pulls instead.
    const clients = await tellClients({ type: "spaces-changed", spaceId: null });
    if (clients.some((c) => c.focused)) return;

    await self.registration.showNotification(SPACE_FALLBACK.title, {
      body: SPACE_FALLBACK.body,
      tag: "space-sync",
      renotify: true,
      icon: "icons/icon-192-v2.png",
      badge: "icons/icon-maskable-192-v2.png",
      data: { url: "./?open=pending" },
    });
  } catch {
    // a missed fallback banner is not worth an error
  } finally {
    try { db.close(); } catch {}
  }
}

self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    // Re-subscribing needs the VAPID key and the space tokens, both of which
    // live in the page - flag it in meta and ask whoever is open to do it.
    let db;
    try { db = await openMetaDB(); } catch { db = null; }
    if (db) {
      try { await metaPut(db, "pushResubscribe", true); } finally { try { db.close(); } catch {} }
    }
    await tellClients({ type: "push-resubscribe" });
  })());
});

// Warm the relay-host cache as soon as the worker starts, so the first fetch
// after a restart already knows whether to bypass.
loadRelayHost();
