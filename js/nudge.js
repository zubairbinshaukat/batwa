// Backup nudge: the PIN has no recovery, so a device with no cloud copy and no
// recent export is one lost phone away from losing everything. Pure decision +
// the banner that carries it.

import { el, anim, animTo } from "./util/dom.js";
import { getMeta, setMeta } from "./db.js";
import { state } from "./ledger.js";
import { getSyncConfig, exportEncrypted, getLastExportAt } from "./sync.js";
import { getKeyMode } from "./auth.js";
import { shortDate } from "./util/format.js";
import { icon } from "./ui/icons.js";
import { toast } from "./ui/toast.js";

const DAY = 86400000;
const STALE_DAYS = 30;
const SNOOZE_DAYS = 14;
const MIN_ENTRIES = 10;

/** Pure — fixture-tested. Every condition has to hold. */
export function shouldNudgeBackup({ entryCount = 0, syncConfigured = false, lastExportAt = null, snoozedUntil = null, now = Date.now() } = {}) {
  if (entryCount < MIN_ENTRIES) return false;
  if (syncConfigured) return false;
  if (snoozedUntil && new Date(snoozedUntil).getTime() > now) return false;
  if (lastExportAt && now - new Date(lastExportAt).getTime() < STALE_DAYS * DAY) return false;
  return true;
}

/**
 * Paint the banner into `slot` when it is earned. `installShowing` is passed in
 * because only one banner may be on screen at a time and install wins.
 */
export async function mountBackupNudge(slot, { installShowing = false } = {}) {
  if (!slot || installShowing) return;
  slot.replaceChildren();
  const { binId, masterKey } = await getSyncConfig();
  const lastExportAt = await getLastExportAt();
  const snoozedUntil = await getMeta("backupNudgeSnoozedUntil");
  if (!shouldNudgeBackup({
    entryCount: state.entries.length,
    syncConfigured: !!(binId && masterKey),
    lastExportAt,
    snoozedUntil,
  })) return;

  const last = lastExportAt ? shortDate(String(lastExportAt).slice(0, 10)) : "never";
  const why = getKeyMode() === "pin"
    ? "There's no PIN recovery — a backup file is the only way back."
    : "Your phone is the only copy.";

  const banner = el("div", { class: "nudge-banner" });
  banner.innerHTML = `
    <span class="nb-ico">${icon("alert", 20)}</span>
    <span class="grow"><strong>Back up your data</strong>
    <p>${why} Last backup: ${last}.</p></span>
  `;
  const bye = () => animTo(banner, { opacity: 0, y: -10, duration: 0.25, onComplete: () => banner.remove() });
  // the two buttons move as one unit: beside the text when there is room, on
  // their own row on a phone
  const actions = el("div", { class: "nb-actions" });
  actions.append(el("button", {
    class: "btn btn-sm",
    onclick: async () => {
      await exportEncrypted();
      toast("Encrypted backup downloaded", { icon: icon("upload", 18) });
      bye();
    },
  }, "Export"));
  actions.append(el("button", {
    class: "btn btn-sm btn-ghost",
    onclick: async () => {
      await setMeta("backupNudgeSnoozedUntil", new Date(Date.now() + SNOOZE_DAYS * DAY).toISOString());
      bye();
    },
  }, "Later"));
  banner.append(actions);
  slot.append(banner);
  anim(banner, { y: -14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: "power2.out" });
}
