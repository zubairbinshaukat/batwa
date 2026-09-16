// Theme: light, dark, or follow the system.
//
// The choice lives in localStorage rather than the encrypted ledger on purpose —
// the tiny boot script in index.html reads it before the first paint, and the
// ledger isn't decrypted until after unlock, which would mean a white flash on
// every open. It says nothing about the user's money, so it's safe out there.

const KEY = "batwa.theme";
const MODES = ["system", "light", "dark"];
const BAR = { light: "#4F33E8", dark: "#100D28" };

const listeners = new Set();
let mq = null;

/** "system" | "light" | "dark" — what the user picked. */
export function getThemeMode() {
  try {
    const v = localStorage.getItem(KEY);
    if (MODES.includes(v)) return v;
  } catch {}
  return "system";
}

/** "light" | "dark" — what is actually on screen right now. */
export function resolvedTheme(mode = getThemeMode()) {
  if (mode === "light" || mode === "dark") return mode;
  try { return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
  catch { return "light"; }
}

function paint() {
  const theme = resolvedTheme();
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", BAR[theme]);
  for (const fn of listeners) { try { fn(theme); } catch {} }
  return theme;
}

export function setThemeMode(mode) {
  const m = MODES.includes(mode) ? mode : "system";
  try { localStorage.setItem(KEY, m); } catch {}
  return paint();
}

/** Called when the theme actually changes, including a system flip on "system". */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function themeLabel(mode = getThemeMode()) {
  return mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System";
}

export function initTheme() {
  try {
    mq = matchMedia("(prefers-color-scheme: dark)");
    // only matters while the mode is "system" — paint() resolves that itself
    const onFlip = () => { if (getThemeMode() === "system") paint(); };
    if (mq.addEventListener) mq.addEventListener("change", onFlip);
    else if (mq.addListener) mq.addListener(onFlip);
  } catch {}
  return paint();
}
