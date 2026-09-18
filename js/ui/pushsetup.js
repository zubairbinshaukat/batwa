// Web Push plumbing for shared spaces (plan §7.1).
//
// This file knows how to get a PushSubscription out of the browser and how to
// listen to what the service worker says afterwards. It deliberately does not
// know about the relay or about Settings: registering the subscription with
// each space (and un-registering it) is M5b's job, and the toggles live in
// js/ui/settings.js. Keeping it apart means the permission dance can be tested
// on its own.
//
// Everything here is best-effort: push is the nicety on top of the pull-on-open
// path, so every failure returns a reason instead of throwing.

const DEVICE_KEY = "batwa.device";

const isStandalone = () => {
  try {
    return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  } catch { return false; }
};

/** Does this browser have the three pieces we need at all? */
export function pushSupported() {
  try {
    return "serviceWorker" in navigator
      && "PushManager" in window
      && "Notification" in window;
  } catch { return false; }
}

/**
 * "on" | "off" | "unavailable" | "not-installed" | "denied"
 * Mirrors remindersState() in js/reminders.js, plus "denied", because a blocked
 * permission is a dead end the user has to fix in browser settings.
 */
export async function pushState() {
  if (!pushSupported()) return "unavailable";
  // iOS only delivers push to a home-screen install (16.4+); same state as reminders.
  if (!isStandalone()) return "not-installed";
  let perm = "default";
  try { perm = Notification.permission; } catch {}
  if (perm === "denied") return "denied";
  if (perm !== "granted") return "off";
  const sub = await currentSubscription();
  return sub ? "on" : "off";
}

async function ready() {
  try { return await navigator.serviceWorker.ready; } catch { return null; }
}

/** The subscription this device already holds, or null. */
export async function currentSubscription() {
  const reg = await ready();
  if (!reg || !reg.pushManager) return null;
  try { return await reg.pushManager.getSubscription(); } catch { return null; }
}

/** The VAPID public key travels as base64url text; subscribe() wants bytes. */
export function urlBase64ToUint8Array(base64url) {
  const s = String(base64url || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Ask for permission (if needed) and subscribe.
 * Resolves `{ ok: true, subscription }` with the plain JSON the relay stores,
 * or `{ ok: false, reason }` with a sentence fit for the UI.
 */
export async function subscribePush(vapidPublicKey) {
  if (!pushSupported()) return { ok: false, reason: "This browser can't receive push notifications." };
  if (!vapidPublicKey) return { ok: false, reason: "Notifications aren't configured for this build." };
  if (!isStandalone() && /iPad|iPhone|iPod/.test(navigator.userAgent || "")) {
    return { ok: false, reason: "Add Batwa to your home screen first — iOS only delivers push to installed apps." };
  }

  let perm = "denied";
  try { perm = await Notification.requestPermission(); } catch {}
  if (perm !== "granted") return { ok: false, reason: "Notifications are blocked — allow them for Batwa first." };

  const reg = await ready();
  if (!reg || !reg.pushManager) return { ok: false, reason: "No service worker to receive notifications." };

  // An existing subscription made with a different VAPID key can't be reused.
  let sub = null;
  try { sub = await reg.pushManager.getSubscription(); } catch {}
  if (sub) {
    const want = urlBase64ToUint8Array(vapidPublicKey);
    if (!sameKey(sub.options && sub.options.applicationServerKey, want)) {
      try { await sub.unsubscribe(); } catch {}
      sub = null;
    }
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    } catch {
      return { ok: false, reason: "The browser wouldn't set up notifications. Try again in a moment." };
    }
  }
  return { ok: true, subscription: subscriptionJSON(sub) };
}

function sameKey(current, want) {
  if (!current) return false;
  const a = new Uint8Array(current);
  if (a.length !== want.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== want[i]) return false;
  return true;
}

/** `{ endpoint, keys: { p256dh, auth } }` — exactly what the Worker's push needs. */
export function subscriptionJSON(sub) {
  if (!sub) return null;
  const j = typeof sub.toJSON === "function" ? sub.toJSON() : sub;
  return { endpoint: j.endpoint, keys: j.keys || {} };
}

/** Drop this device's subscription. Telling the relay is the caller's job. */
export async function unsubscribePush() {
  const sub = await currentSubscription();
  if (!sub) return { ok: true, had: false };
  try {
    await sub.unsubscribe();
    return { ok: true, had: true };
  } catch {
    return { ok: false, had: true, reason: "Couldn't turn notifications off in the browser." };
  }
}

/**
 * A random id for this browser profile, kept in localStorage so it survives a
 * re-subscribe. The relay keys subscriptions by it, so two phones of the same
 * person both get notified (§9.6). Not a user id: it never leaves this device
 * except as a key on our own relay.
 */
export function deviceId() {
  let id = null;
  try { id = localStorage.getItem(DEVICE_KEY); } catch {}
  if (id) return id;
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try { localStorage.setItem(DEVICE_KEY, id); } catch {}
  return id;
}

/**
 * Wire up the three things sw.js posts to the page:
 *   { type: "spaces-changed", spaceId }  a push landed — pull that space
 *   { type: "open", url }                a notification was tapped
 *   { type: "push-resubscribe" }         the browser rotated our subscription
 * Returns a function that removes the listener.
 */
export function installPushMessageHandlers({ onSpacesChanged, onOpen, onResubscribe } = {}) {
  if (!("serviceWorker" in navigator)) return () => {};
  const handler = (e) => {
    const d = e && e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "spaces-changed" && onSpacesChanged) onSpacesChanged(d.spaceId || null);
    else if (d.type === "open" && onOpen) onOpen(String(d.url || "./"));
    else if (d.type === "push-resubscribe" && onResubscribe) onResubscribe();
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => {
    try { navigator.serviceWorker.removeEventListener("message", handler); } catch {}
  };
}
