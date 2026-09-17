/* Batwa service worker — app shell cache only. Never touches user data. */
const CACHE = "batwa-v21";

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
  "./branding/logo.svg",
  "./js/vendor/gsap.min.js",
  "./js/app.js",
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
  "./js/ui/home.js",
  "./js/ui/accounts.js",
  "./js/ui/icons.js",
  "./js/ui/reports.js",
  "./js/ui/history.js",
  "./js/ui/settings.js",
  "./js/ui/modals.js",
  "./js/ui/charts.js",
  "./js/ui/toast.js",
  "./js/util/format.js",
  "./js/util/dom.js",
  "./js/util/expr.js",
  "./icons/favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon-180.png"
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
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Sync API: network only, never cached.
  if (url.hostname.includes("jsonbin.io")) return;

  if (e.request.method !== "GET") return;

  // Navigations: cache-first shell so cold offline launches are instant.
  if (e.request.mode === "navigate") {
    e.respondWith(
      caches.match("./index.html").then((hit) => hit || fetch(e.request))
    );
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
      icon: "icons/icon-192.png",
      badge: "icons/icon-maskable-192.png",
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
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) return c.focus();
    }
    return self.clients.openWindow("./");
  })());
});
