// Build step for the service worker. sw.js stays a hand-written classic worker
// at the repo root; this plugin copies it into dist/ with exactly three values
// filled in from the build, and every other byte left alone:
//
//   CACHE     "batwa-v<APP_VERSION>-<hash>". APP_VERSION comes from
//             js/config.js so Settings and the cache agree; the hash covers
//             the path AND bytes of every file in dist/ the worker may cache:
//             the precache, and also everything it caches on first use (bank
//             logos, the author avatar, small icons, install screenshots...).
//             So any shipped change opens a new cache and the old one is
//             deleted on activate, the same as bumping the number by hand.
//             Only sw.js itself and NO_CACHE files (which the worker never
//             stores) are left out.
//   SHELL     "./", "./index.html", the public files the source SHELL lists
//             (manifest, fonts, gsap, exceljs, icons...), then every JS/CSS/
//             asset file the index.html entry can reach, static and dynamic
//             imports alike, read from Vite's .vite/manifest.json.
//   NO_CACHE  the source regex, plus the files only about.html uses (its
//             entry chunk and CSS). The about page must never be cached by the
//             app's worker; chunks it shares with the app stay in SHELL.
//
// The build fails if a SHELL entry is missing from dist/, if a precached file
// would also match NO_CACHE, or if any of the three lines can't be found.
// .vite/manifest.json is deleted afterwards so it is never deployed.
//
// No dependencies beyond Node itself, on purpose.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const CACHE_RE = /^const CACHE = "[^"\n]*";$/m;
const NO_CACHE_RE = /^const NO_CACHE = \/(.+)\/;$/m;
const SHELL_RE = /^const SHELL = (\[[^\]]*\]);$/m;
const VERSION_RE = /^export const APP_VERSION = "([^"\n]+)";$/m;

/** Exactly one match, or the build stops: silently skipping would ship a stale value. */
function one(text, re, what, file) {
  const all = text.match(new RegExp(re.source, re.flags + "g")) || [];
  if (all.length !== 1) {
    throw new Error(`[batwa-sw] expected exactly one ${what} in ${file}, found ${all.length}`);
  }
  return text.match(re);
}

/** Every file (JS, CSS, assets) reachable from one manifest entry, in walk order. */
function reachable(manifest, key) {
  const files = [];
  const seenKeys = new Set();
  const add = (f) => { if (!files.includes(f)) files.push(f); };
  (function walk(k) {
    if (seenKeys.has(k)) return;
    seenKeys.add(k);
    const chunk = manifest[k];
    if (!chunk) throw new Error(`[batwa-sw] ${k} is not in .vite/manifest.json`);
    add(chunk.file);
    for (const f of chunk.css || []) add(f);
    for (const f of chunk.assets || []) add(f);
    for (const i of chunk.imports || []) walk(i);
    for (const i of chunk.dynamicImports || []) walk(i);
  })(key);
  return files;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Every file under `dir`, as "a/b.c" with forward slashes on every OS, sorted. */
function listFiles(dir, prefix = "") {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...listFiles(join(dir, d.name), rel));
    else if (d.isFile()) out.push(rel);
  }
  return out.sort();
}

export default function batwaServiceWorker({ source = "sw.js", config = "js/config.js" } = {}) {
  let root, outDir, publicDir, manifestFile;

  return {
    name: "batwa-sw",
    apply: "build",

    configResolved(c) {
      root = c.root;
      outDir = resolve(root, c.build.outDir);
      publicDir = c.publicDir;
      if (c.build.manifest !== true) {
        // A custom manifest path would be fine too, but then it has to be
        // kept out of dist/ by hand; one fixed place keeps this simple.
        throw new Error("[batwa-sw] needs build.manifest: true");
      }
      manifestFile = join(outDir, ".vite", "manifest.json");
    },

    // After everything, public/ included, is on disk: the checks below look
    // at the real dist/, not at what Vite meant to write.
    closeBundle() {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      rmSync(join(outDir, ".vite"), { recursive: true, force: true });

      const swFile = resolve(root, source);
      const sw = readFileSync(swFile, "utf8");
      const version = one(readFileSync(resolve(root, config), "utf8"), VERSION_RE, "APP_VERSION", config)[1];

      // --- SHELL ---------------------------------------------------------
      // Public files come from the source SHELL itself, so there is still
      // one list to edit when a vendored file or an icon joins the precache.
      // Its other entries name source files (the dev defaults) that the
      // bundle replaces; anything that is neither is a typo or a deleted
      // file, and stops the build.
      const sourceShell = JSON.parse(one(sw, SHELL_RE, "SHELL array", source)[1]);
      const publicEntries = [];
      for (const entry of sourceShell) {
        if (entry === "./" || entry === "./index.html") continue;
        const rel = entry.replace(/^\.\//, "");
        if (existsSync(join(publicDir, rel))) publicEntries.push(entry);
        else if (!existsSync(join(root, rel))) {
          throw new Error(`[batwa-sw] ${source} SHELL lists ${entry}, which is neither in public/ nor a source file`);
        }
      }
      const indexFiles = reachable(manifest, "index.html");
      const shell = [
        "./",
        "./index.html",
        ...publicEntries,
        ...indexFiles.map((f) => "./" + f).filter((f) => !publicEntries.includes(f)),
      ];

      for (const entry of shell) {
        const file = join(outDir, entry === "./" ? "index.html" : entry.slice(2));
        if (!existsSync(file) || !statSync(file).isFile()) {
          throw new Error(`[batwa-sw] SHELL entry ${entry} is missing from ${outDir}`);
        }
      }

      // --- NO_CACHE ------------------------------------------------------
      // Only files index.html never reaches: a chunk shared by both pages is
      // precached for the app and must stay cacheable.
      const oldNoCache = one(sw, NO_CACHE_RE, "NO_CACHE regex", source)[1];
      if (!oldNoCache.endsWith(")$")) {
        throw new Error("[batwa-sw] NO_CACHE no longer ends in `)$`; update build/vite-plugin-sw.js to match");
      }
      const aboutOnly = manifest["about.html"]
        ? reachable(manifest, "about.html").filter((f) => !indexFiles.includes(f))
        : [];
      const noCacheSrc = aboutOnly.length
        ? oldNoCache.slice(0, -2) + "|" + aboutOnly.map(escapeRe).join("|") + ")$"
        : oldNoCache;
      const noCache = new RegExp(noCacheSrc);
      for (const f of aboutOnly) {
        if (!noCache.test("/" + f)) throw new Error(`[batwa-sw] NO_CACHE does not match about-only ${f}`);
      }
      for (const entry of shell) {
        const path = "/" + (entry === "./" ? "" : entry.slice(2));
        if (noCache.test(path)) throw new Error(`[batwa-sw] precached ${entry} also matches NO_CACHE`);
      }

      // --- CACHE ---------------------------------------------------------
      // The SHELL list itself (order included), then every cacheable file in
      // dist/ by path and bytes. Paths use "/" on every OS so a Windows and a
      // Linux build of the same commit produce the same name.
      const hash = createHash("sha256");
      hash.update(JSON.stringify(shell) + "\0");
      let hashed = 0;
      for (const rel of listFiles(outDir)) {
        if (rel === "sw.js" || noCache.test("/" + rel)) continue;
        hash.update(rel + "\0").update(readFileSync(join(outDir, rel))).update("\0");
        hashed++;
      }
      const cache = `batwa-v${version}-${hash.digest("hex").slice(0, 10)}`;

      // --- write -----------------------------------------------------------
      // Function replacers, so a "$" in a value is never read as a pattern.
      const out = sw
        .replace(CACHE_RE, () => `const CACHE = ${JSON.stringify(cache)};`)
        .replace(NO_CACHE_RE, () => `const NO_CACHE = /${noCacheSrc}/;`)
        .replace(SHELL_RE, () => `const SHELL = ${JSON.stringify(shell, null, 2)};`);
      writeFileSync(join(outDir, "sw.js"), out);

      console.log(`\n[batwa-sw] ${cache}: ${shell.length} precached files, ${hashed} cacheable files hashed, ${aboutOnly.length} about-only files never cached`);
    },
  };
}

/*
 * Dev only (`npm run dev`): answer /sw.js with a worker that removes itself.
 *
 * `npm run dev` and `npm run preview` both use port 8000, the port the app was
 * always tested on, so localhost:8000 may still have a Batwa worker from an
 * earlier session (python http.server, or a preview build). That worker serves
 * the OLD app cache-first, so the dev page would never even load. The old page
 * still asks the network for /sw.js when it registers, and gets this: it takes
 * over at once, deletes every cache on the origin, unregisters, and reloads
 * the open tabs, which then come straight from the dev server. The dev app
 * itself never registers a worker (see registerSW in js/app.js).
 */
const DEV_RESET_SW = `// Batwa dev server: clean-up worker (never deployed).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: "window" })) {
      try { c.navigate(c.url); } catch {}
    }
  })());
});
`;

export function batwaDevSwReset() {
  return {
    name: "batwa-dev-sw-reset",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url || "").split("?")[0] !== "/sw.js") return next();
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(DEV_RESET_SW);
      });
    },
  };
}
