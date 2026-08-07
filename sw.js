/* Batwa service worker — app shell cache only. Never touches user data. */
const CACHE = "batwa-v2";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/tokens.css",
  "./css/base.css",
  "./css/components.css",
  "./fonts/outfit-var.woff2",
  "./js/vendor/gsap.min.js",
  "./js/app.js",
  "./js/db.js",
  "./js/crypto.js",
  "./js/auth.js",
  "./js/ledger.js",
  "./js/sync.js",
  "./js/ui/home.js",
  "./js/ui/accounts.js",
  "./js/ui/reports.js",
  "./js/ui/settings.js",
  "./js/ui/modals.js",
  "./js/ui/charts.js",
  "./js/ui/toast.js",
  "./js/util/format.js",
  "./js/util/dom.js",
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
