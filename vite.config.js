// Batwa's build. Vite only changes how the files are built and served: the
// app, its URLs, its storage and its service worker logic stay as they were.
//
// Sources stay where they always were (index.html, about.html, js/, css/,
// sw.js at the repo root). Files served as-is, never bundled, live in public/
// under the same relative paths, so every URL an installed app, a manifest or
// stored data can point at is unchanged: manifest.webmanifest, icons/,
// screenshots/, fonts/, branding/banks/, js/vendor/gsap.min.js and
// js/vendor/exceljs.min.js (loaded by path at runtime), css/installguide.css.
//
// Only the two pages are inputs, so relay/, test/, tools/ and the docs are
// never copied into dist/ (and so, since v36, never deployed).

import { defineConfig } from "vite";
import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import batwaServiceWorker, { batwaDevSwReset } from "./build/vite-plugin-sw.js";

const ROOT = dirname(fileURLToPath(import.meta.url));

// "<imported module> <- <module that import()s it>", repo-relative. Matched
// exactly, so any other ineffective dynamic import still warns.
const DELIBERATE_CYCLE_BREAKS = new Set([
  "js/ledger.js <- js/auth.js",
  "js/ui/accounts.js <- js/auth.js",
  "js/ui/toast.js <- js/auth.js",
  "js/spaces.js <- js/sync.js",
  "js/app.js <- js/ui/spaces.js",
  "js/app.js <- js/ui/spaceview.js",
]);
const repoPath = (id) => relative(ROOT, id || "").split(sep).join("/");
// Rolldown's log: `id` is the module import()ed, `ids[0]` the importer.
const cycleKey = (log) => `${repoPath(log.id)} <- ${repoPath(log.ids && log.ids[0])}`;

export default defineConfig({
  root: ".",
  // Relative URLs everywhere, as before: the built app still works from a
  // sub-folder, and the manifest's "./" start_url and scope still hold.
  base: "./",
  publicDir: "public",
  // Two real pages, no client-side router: `vite dev` and `vite preview`
  // answer an unknown path with a 404, the way the static host does, instead
  // of quietly serving index.html.
  appType: "mpa",

  // Same port as always (python -m http.server 8000), for `npm run dev` and
  // `npm run preview` alike. strictPort: if 8000 is taken, stop with an error
  // instead of quietly moving to 8001, where the app would be a different
  // origin with none of your local data.
  server: { port: 8000, strictPort: true },
  preview: { port: 8000, strictPort: true },

  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Read by build/vite-plugin-sw.js to list the precache, then deleted
    // from dist/ so it is never deployed.
    manifest: true,
    // The sources already run natively in every browser Batwa supports, so
    // don't down-level anything: same syntax out as in, no helpers. Same for
    // CSS, so no prefix is added or dropped (-webkit-backdrop-filter matters
    // on Safari).
    target: "esnext",
    cssTarget: "esnext",
    // CSS ships unminified, as it always has. Vite's default CSS minifier
    // (Lightning CSS) folds each `-webkit-backdrop-filter` + `backdrop-filter`
    // pair into the prefixed one alone, which drops every blur in Chrome and
    // Firefox, and it rewrites values the page never asked it to. Found by
    // diffing computed styles of v35.1 against this build; with minify off
    // they match.
    cssMinify: false,
    // Vite's polyfill makes browsers without <link rel="modulepreload">
    // fetch() every chunk up front. Those browsers used to just ignore the
    // hint and load modules as imported; keep it that way.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: { index: "index.html", about: "about.html" },
      // Views and heavy sheets load on demand through js/ui/lazy.js. A static
      // import of one of them from the start-up path would quietly fold it
      // back into the main bundle, and this check is what says so. It stays
      // on; only the dynamic imports below are let through, because each is
      // deliberately also static: they break import cycles at load time (see
      // js/app.js), they were never meant to split anything off.
      onLog(level, log, handler) {
        if (log.code === "INEFFECTIVE_DYNAMIC_IMPORT" && DELIBERATE_CYCLE_BREAKS.has(cycleKey(log))) return;
        handler(level, log);
      },
      checks: { ineffectiveDynamicImport: true },
    },
  },

  plugins: [batwaServiceWorker(), batwaDevSwReset()],
});
