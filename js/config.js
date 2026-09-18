// Build-time-ish constants: the endpoints Batwa talks to, in one place.
// Nothing here is a secret — the relay URL and the VAPID *public* key are
// deliberately public. Everything private stays inside the encrypted blob.
//
// sw.js cannot import this file (a classic worker has no ES imports), so the
// page hands it the relay hostname on registration via postMessage and the
// worker stores it in IDB meta `relayHost`.

/** Cloudflare Worker relay base URL, no trailing slash. "" = shared spaces off. */
export const RELAY_URL = "https://batwa-relay.liter-book.workers.dev";

/** Web Push application server key (public half). "" = push off. */
export const VAPID_PUBLIC_KEY = "BD15vxCPRqUUfyzO6h8dvFhRZafCh3P1TC4Md9K-ec83FFDEWQ_sUL4qI3DHlJrq558a7lvMVZ4L4kRfGjAtR6U";

/** JSONBin.io bins API — personal sync only, ciphertext only. */
export const JSONBIN_API = "https://api.jsonbin.io/v3/b";

/**
 * The relay URL actually in force. `localStorage["batwa.relay"]` overrides the
 * constant so headless tests can point at `wrangler dev` without editing this
 * file. Returns "" when shared spaces are disabled.
 */
export function relayUrl() {
  try {
    const override = localStorage.getItem("batwa.relay");
    if (override) return override;
  } catch {
    // private mode / storage blocked — fall through to the constant
  }
  return RELAY_URL;
}

/** Hostname of the relay in force, or null when there isn't one. */
export function relayHost() {
  const url = relayUrl();
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch { return null; }
}

/**
 * App version, shown in Settings and in the about page's JSON-LD.
 * MUST match the `CACHE` number in sw.js (`batwa-v<APP_VERSION>`): sw.js is a
 * classic worker and cannot import this file, so the two are bumped together.
 */
export const APP_VERSION = "32";
