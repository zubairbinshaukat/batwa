// Regenerate the about page's responsive images from their PNG sources.
//
//   cd tools && npm install && npm run images
//
// Dev-only: the app never loads this, and nothing here runs at build time
// (there is no build). Commit the files it writes.
//
// Why these settings: measured against the original PNGs with SSIM, AVIF at
// quality 62 comes out BOTH smaller and closer to the source than the WebP
// files it replaced (hero-home 1184w: 62 KB at 0.9954 vs 174 KB at 0.9927).
// WebP at quality 82 stays as the fallback for browsers without AVIF.

import sharp from "sharp";
import { statSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "screenshots");

const AVIF = { quality: 62, effort: 7 };
const WEBP = { quality: 82, effort: 6, smartSubsample: true };

/** The two floating hero renders: every width the page's srcset offers. */
const HEROES = ["hero-home", "hero-spaces"];
const HERO_WIDTHS = [480, 640, 800, 1184];

/** The four app screenshots: one AVIF next to the existing WebP and PNG. */
const SCREENS = ["01-home", "02-reports", "03-history", "04-add"];

const kb = (file) => `${Math.round(statSync(file).size / 1024)} KB`;

async function write(pipeline, file) {
  await pipeline.toFile(file);
  console.log(`  ${file.slice(ROOT.length + 1)}  ${kb(file)}`);
}

for (const name of HEROES) {
  const src = join(SHOTS, `${name}.png`);
  console.log(name);
  for (const w of HERO_WIDTHS) {
    const base = () => sharp(src).resize({ width: w, withoutEnlargement: true });
    await write(base().avif(AVIF), join(SHOTS, `${name}-${w}.avif`));
    await write(base().webp(WEBP), join(SHOTS, `${name}-${w}.webp`));
  }
}

for (const name of SCREENS) {
  const src = join(SHOTS, `${name}.png`);
  console.log(name);
  await write(sharp(src).avif(AVIF), join(SHOTS, `${name}.avif`));
}

// The 3D logo in the about page's header and footer shows at 34px and 30px:
// a 68px WebP (2x) instead of the 192px PNG, same render, a tenth the bytes.
console.log("logo");
await write(
  sharp(join(ROOT, "icons", "icon-192-v2.png")).resize(68, 68).webp({ quality: 90, effort: 6 }),
  join(ROOT, "icons", "logo-68.webp"),
);

// Install-guide screenshots, when they exist: screenshots/install/*.png ->
// 720px AVIF + WebP next to them (see js/installguide.js, SHOTS).
const GUIDE = join(SHOTS, "install");
if (existsSync(GUIDE)) {
  for (const file of readdirSync(GUIDE).filter((f) => f.endsWith(".png"))) {
    const src = join(GUIDE, file);
    const stem = file.replace(/\.png$/, "");
    console.log(`install/${stem}`);
    const base = () => sharp(src).resize({ width: 720, withoutEnlargement: true });
    await write(base().avif(AVIF), join(GUIDE, `${stem}.avif`));
    await write(base().webp(WEBP), join(GUIDE, `${stem}.webp`));
  }
}
