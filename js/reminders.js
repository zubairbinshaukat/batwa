// Bill reminders: a local notification posted by the service worker on a
// periodic background sync. Chrome for Android has no Badging API, so the
// notification (and the launcher dot Android draws for it) is the only way an
// installed Batwa can say "something is due".
//
// Nothing here touches the encrypted blob. The SW only ever reads meta
// `dueSchedule` (dates + counts), `remindLastDay` and `remindersOn`.

import { getMeta, setMeta, dbDel } from "./db.js";
import { state, dueSchedule, setRemindersFlag } from "./ledger.js";
import { isoDate } from "./util/format.js";

export const DUE_TAG = "batwa-due";
const MIN_INTERVAL = 12 * 60 * 60 * 1000;

/**
 * CANONICAL COPY. `sw.js` carries a byte-identical duplicate because a classic
 * service worker cannot import an ES module — change both together (there is a
 * fixture that asserts the two are textually the same).
 */
export function dueSummary(schedule, today) {
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

const isStandalone = () => {
  try {
    return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  } catch { return false; }
};

export function remindersSupported() {
  try {
    return "serviceWorker" in navigator
      && "Notification" in window
      && "periodicSync" in ServiceWorkerRegistration.prototype;
  } catch { return false; }
}

/** "on" | "off" | "unavailable" | "not-installed" */
export async function remindersState() {
  if (!remindersSupported()) return "unavailable";
  if (!isStandalone()) return "not-installed";
  let granted = false;
  try { granted = Notification.permission === "granted"; } catch {}
  const on = !!(await getMeta("remindersOn"));
  return on && granted ? "on" : "off";
}

async function ready() {
  try { return await navigator.serviceWorker.ready; } catch { return null; }
}

export async function enableReminders() {
  if (!remindersSupported()) return { ok: false, reason: "This browser can't run background reminders." };
  let perm = "denied";
  try { perm = await Notification.requestPermission(); } catch {}
  if (perm !== "granted") return { ok: false, reason: "Notifications are blocked — allow them for Batwa first." };
  const reg = await ready();
  if (!reg || !reg.periodicSync) return { ok: false, reason: "Install Batwa to the home screen first." };
  try {
    await reg.periodicSync.register(DUE_TAG, { minInterval: MIN_INTERVAL });
  } catch {
    return { ok: false, reason: "Android turned background sync down for Batwa — open the app a few more times." };
  }
  await setMeta("remindersOn", true);
  setRemindersFlag(true);
  await setMeta("dueSchedule", dueSchedule(state.entries)); // first run has data straight away
  return { ok: true };
}

export async function disableReminders() {
  const reg = await ready();
  try { reg && reg.periodicSync && (await reg.periodicSync.unregister(DUE_TAG)); } catch {}
  await setMeta("remindersOn", false);
  setRemindersFlag(false);
  try { await dbDel("meta", "dueSchedule"); } catch {}
  try { await dbDel("meta", "remindLastDay"); } catch {}
  return { ok: true };
}

/** Post one right now so the user sees exactly what Android will show. */
export async function sendTestReminder() {
  const reg = await ready();
  if (!reg || !reg.showNotification) return { ok: false, reason: "No service worker to post from." };
  const today = isoDate();
  const schedule = (await getMeta("dueSchedule")) || dueSchedule(state.entries, today);
  const { text } = dueSummary(schedule, today);
  try {
    await reg.showNotification("Batwa", {
      body: text || "Nothing due today — this is what a reminder looks like.",
      tag: DUE_TAG,
      icon: "icons/icon-192-v2.png",
      badge: "icons/icon-maskable-192-v2.png",
      data: { url: "./" },
    });
  } catch {
    return { ok: false, reason: "Android wouldn't show the notification." };
  }
  return { ok: true };
}
