// JSONBin.io sync: push/pull the ENCRYPTED blob only. Plus manual export/import.
// Sync is an enhancement — every failure degrades gracefully, never blocks.

import { dbGet, dbPut, getMeta, setMeta } from "./db.js";
import { JSONBIN_API } from "./config.js";
import { getKey } from "./auth.js";
import { decrypt, deriveKey, unb64 } from "./crypto.js";
import { state, replaceAll, mergeData } from "./ledger.js";
import { timeAgo } from "./util/format.js";
import { toast } from "./ui/toast.js";
import { chooseSheet, confirmSheet, sheetOpen, openSheet, closeSheet } from "./ui/modals.js";
import { el } from "./util/dom.js";
import { icon } from "./ui/icons.js";

/** Paste this into a fresh JSONBin bin — the app treats it as "empty, push mine". */
export const STARTER_JSON = '{ "app": "batwa", "version": 1, "updatedAt": null, "salt": null, "cipher": null }';

let debounceTimer = null;
let syncing = false;
let lastError = null;
const listeners = new Set();
export const onSyncState = (cb) => listeners.add(cb);
function notify() { for (const cb of listeners) { try { cb(); } catch {} } }

/** One-word state for the header pill. */
export async function getSyncState() {
  const { binId, masterKey, lastSyncedAt } = await getSyncConfig();
  if (!binId || !masterKey) return { state: "off", text: "Local only" };
  if (!navigator.onLine) return { state: "offline", text: "Offline · saved locally" };
  if (syncing) return { state: "syncing", text: "Syncing…" };
  const updatedAt = await getMeta("updatedAt");
  if (updatedAt && (!lastSyncedAt || updatedAt > lastSyncedAt)) {
    return { state: "pending", text: lastError ? "Retry sync" : "Sync pending" };
  }
  return { state: "synced", text: timeAgo(lastSyncedAt) };
}

export async function getSyncConfig() {
  return {
    binId: (await getMeta("binId")) || "",
    masterKey: (await getMeta("masterKey")) || "",
    lastSyncedAt: (await getMeta("lastSyncedAt")) || null,
  };
}

export async function setSyncConfig(binId, masterKey) {
  await setMeta("binId", binId.trim());
  await setMeta("masterKey", masterKey.trim());
}

export async function syncStatusText() {
  const { binId, masterKey, lastSyncedAt } = await getSyncConfig();
  if (!binId || !masterKey) return { text: "Sync not set up", cls: "is-off" };
  if (!navigator.onLine) return { text: "Offline — will sync when back", cls: "is-stale" };
  const updatedAt = await getMeta("updatedAt");
  const stale = updatedAt && (!lastSyncedAt || updatedAt > lastSyncedAt);
  return { text: stale ? "Changes not synced yet" : timeAgo(lastSyncedAt), cls: stale ? "is-stale" : "" };
}

/** Debounced auto-sync ~3s after any data change. */
export function scheduleSync() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => syncNow({ silent: true }), 3000);
}

// fire queued sync when connectivity returns
window.addEventListener("online", () => scheduleSync());

async function remoteGet(binId, masterKey) {
  const res = await fetch(`${JSONBIN_API}/${binId}/latest`, {
    headers: { "X-Master-Key": masterKey },
  });
  if (res.status === 401 || res.status === 403) throw new Error("bad-key");
  if (res.status === 404) throw new Error("not-found");
  if (res.status === 429) throw new Error("rate-limit");
  if (!res.ok) throw new Error("http-" + res.status);
  const json = await res.json();
  return json.record || null;
}

async function remotePut(binId, masterKey, payload) {
  const res = await fetch(`${JSONBIN_API}/${binId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": masterKey },
    body: JSON.stringify(payload),
  });
  if (res.status === 401 || res.status === 403) throw new Error("bad-key");
  if (res.status === 429) throw new Error("rate-limit");
  if (!res.ok) throw new Error("http-" + res.status);
}

/**
 * Portability key material, independent of the local key MODE:
 *  - PIN mode: the real PBKDF2 salt (`pinSalt`) — a payload built under it can
 *    only be opened by re-deriving from the same PIN, which is the point.
 *  - Device mode: there's no PIN to re-derive from, so the raw device key
 *    itself travels with the payload. That's not a new weakness — device mode
 *    already unlocks with no prompt at all on this phone (see auth.js), so a
 *    payload readable by anyone holding the sync credentials (or the backup
 *    file) matches the security level Settings already documents for it.
 * Both fields are additive; old clients that only know `salt`/`cipher` keep
 * working against PIN-mode payloads exactly as before.
 */
async function keyMaterial() {
  const pinSalt = await getMeta("pinSalt");
  const deviceKey = await getMeta("deviceKey");
  if (pinSalt) return { keyMode: "pin", salt: pinSalt, deviceKey: null };
  if (deviceKey) return { keyMode: "device", salt: null, deviceKey };
  return { keyMode: "none", salt: null, deviceKey: null };
}

const importRawKey = (rawB64) =>
  crypto.subtle.importKey("raw", unb64(rawB64), { name: "AES-GCM" }, false, ["decrypt"]);

async function buildPayload() {
  const blob = await dbGet("entries", "blob");
  return {
    app: "batwa",
    version: 1,
    updatedAt: (await getMeta("updatedAt")) || new Date().toISOString(),
    ...(await keyMaterial()), // keyMode + salt (pin) + deviceKey (no-pin) — see keyMaterial()
    cipher: blob || null,
  };
}

/** Ask for the OTHER device's PIN to unlock a cloud copy pushed by it. */
function askRemotePin() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openSheet("Cloud copy is PIN-locked", (body) => {
      body.append(el("p", { class: "muted", style: "margin-bottom:16px" },
        "This cloud copy was encrypted on another device. Enter that device's PIN to unlock it here — your PIN on this device stays as it is."));
      const input = el("input", {
        class: "input", type: "password", inputmode: "numeric",
        autocomplete: "off", placeholder: "PIN", style: "margin-bottom:16px",
      });
      const go = () => {
        const v = input.value.trim();
        if (!v) { input.focus(); return; }
        finish(v);
        closeSheet();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      body.append(input,
        el("div", { class: "form-actions" },
          el("button", { class: "btn btn-ghost", onclick: () => { finish(null); closeSheet(); } }, "Cancel"),
          el("button", { class: "btn btn-primary", onclick: go }, "Unlock")
        )
      );
    }, { onDismiss: () => finish(null) });
  });
}

async function pullRemote(remote) {
  if (!remote?.cipher) return false;
  let key = getKey();
  let viaDeviceKey = false;
  let viaRemotePin = false;

  if (remote.deviceKey) {
    // No-PIN payload: the key travels with it, so sync credentials alone unlock it —
    // no need for this device's current key (whatever mode it's in) to match.
    try {
      key = await importRawKey(remote.deviceKey);
      viaDeviceKey = true;
    } catch {
      toast("Remote data is damaged", { icon: icon("alert", 18) });
      return false;
    }
  } else {
    const localSalt = await getMeta("pinSalt");
    if (remote.salt && remote.salt !== localSalt) {
      // Blob encrypted under another device's PIN setup. Same PIN ≠ same key
      // (every device rolls its own salt), so re-derive with the REMOTE salt
      // and that device's PIN — mirrors what importBackup does for files.
      const pin = await askRemotePin();
      if (!pin) return false;
      try {
        key = await deriveKey(pin, remote.salt);
      } catch {
        toast("Remote data is damaged", { icon: icon("alert", 18) });
        return false;
      }
      viaRemotePin = true;
    }
  }

  try {
    const data = await decrypt(key, remote.cipher);
    await replaceAll(data);
    await setMeta("updatedAt", remote.updatedAt);
    // The bundles just changed underneath the space cache, so every space is
    // re-read and re-pulled before anything reads a stale blob (plan §9.7).
    // Imported lazily: sync.js must not drag the whole spaces module into the
    // boot path for a phone that has never made a space.
    try {
      const m = await import("./spaces.js");
      await m.reloadSpacesAfterSync();
    } catch (err) { console.warn("space re-pull after sync failed", err); }
    return true;
  } catch {
    toast(
      viaRemotePin ? "Wrong PIN for the cloud copy — try again from Sync now"
        : viaDeviceKey ? "Couldn't decrypt remote data"
        : "Couldn't decrypt remote data with this PIN",
      { icon: icon("alert", 18) }
    );
    return false;
  }
}

const ERRORS = {
  "bad-key": "Sync failed: JSONBin key rejected",
  "not-found": "Sync failed: Bin ID not found",
  "rate-limit": "Sync paused: JSONBin rate limit hit",
};

export async function syncNow({ silent = false } = {}) {
  if (syncing) return;
  const { binId, masterKey, lastSyncedAt } = await getSyncConfig();
  if (!binId || !masterKey) { if (!silent) toast("Add your JSONBin details in Settings first"); return; }
  if (!navigator.onLine) { if (!silent) toast("You're offline — sync will run when you're back", { icon: icon("cloud-off", 18) }); return; }
  if (!getKey()) return;

  syncing = true;
  notify();
  try {
    const localUpdated = (await getMeta("updatedAt")) || null;
    const remote = await remoteGet(binId, masterKey);
    const remoteUpdated = remote?.app === "batwa" ? remote.updatedAt : null;

    const localChanged = localUpdated && (!lastSyncedAt || localUpdated > lastSyncedAt);
    const remoteChanged = remoteUpdated && (!lastSyncedAt || remoteUpdated > lastSyncedAt);

    // Never interrupt the user mid-form with a conflict dialog — retry later.
    if (remoteChanged && silent && sheetOpen()) {
      scheduleSync();
      return;
    }

    if (remoteChanged && localChanged) {
      // Both moved since last sync — never silently overwrite.
      const pick = await chooseSheet({
        title: "Sync conflict",
        message: "Both this device and the cloud copy changed since the last sync. Which one should win?",
        options: [
          { label: "Keep this device (push)", value: "local", style: "btn-primary" },
          { label: "Keep cloud copy (pull)", value: "remote" },
          { label: "Download both as files", value: "files", style: "btn-ghost" },
        ],
      });
      if (pick === "remote") {
        if (await pullRemote(remote)) toast("Cloud copy restored", { icon: icon("cloud", 18) });
      } else if (pick === "local") {
        await remotePut(binId, masterKey, await buildPayload());
        toast("Pushed this device's data", { icon: icon("cloud", 18) });
      } else if (pick === "files") {
        downloadJSON(await buildPayload(), "batwa-local.json");
        downloadJSON(remote, "batwa-remote.json");
        toast("Both copies downloaded");
        return;
      } else {
        return; // dismissed — do nothing
      }
    } else if (remoteChanged) {
      const ok = await confirmSheet({
        title: "Newer data in the cloud",
        message: "The cloud copy is newer than this device. Pull it down?",
        confirmLabel: "Pull latest",
      });
      if (ok) {
        if (await pullRemote(remote)) toast("Up to date with cloud", { icon: icon("cloud", 18) });
      } else return;
    } else if (localChanged || !remoteUpdated) {
      await remotePut(binId, masterKey, await buildPayload());
      if (!silent) toast("Synced", { icon: icon("cloud", 18) });
    } else if (!silent) {
      toast("Already up to date", { icon: icon("check-circle", 18) });
    }

    await setMeta("lastSyncedAt", new Date().toISOString());
    lastError = null;
  } catch (err) {
    lastError = err.message;
    const msg = ERRORS[err.message] || "Sync failed — will retry later";
    if (!silent) toast(msg, { icon: icon("alert", 18) });
    if (err.message !== "bad-key" && err.message !== "not-found") {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => syncNow({ silent: true }), 60000); // auto-retry transient failures
    }
  } finally {
    syncing = false;
    notify();
  }
}

/* ============================================================
   Manual backup: export / import
   ============================================================ */

export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** When the last backup file was written (meta, local only — never in a payload). */
export const getLastExportAt = () => getMeta("lastExportAt");

/** The browser can silently drop a download, so this is "we offered a file", not proof. */
const stampExport = () => setMeta("lastExportAt", new Date().toISOString());

export async function exportEncrypted() {
  const blob = await dbGet("entries", "blob");
  downloadJSON({
    type: "batwa-backup",
    encrypted: true,
    exportedAt: new Date().toISOString(),
    ...(await keyMaterial()), // keyMode + salt (pin) + deviceKey (no-pin) — see keyMaterial()
    cipher: blob,
    categories: state.categories,
    catIcons: state.catIcons, // travels with `categories` — same meta, same rules
  }, `batwa-backup-${new Date().toISOString().slice(0, 10)}.json`);
  await stampExport();
}

export async function exportPlain() {
  downloadJSON({
    type: "batwa-backup",
    encrypted: false,
    exportedAt: new Date().toISOString(),
    entries: state.entries,
    accounts: state.accounts,
    // Shared-space bundles carry the write token and data key for each space in
    // clear in a PLAIN export — that is the whole point of a plain export, and
    // the warning next to the button already says so.
    spaces: state.spaces,
    contacts: state.contacts,
    profile: state.profile,
    categories: state.categories,
    catIcons: state.catIcons, // travels with `categories` — same meta, same rules
  }, `batwa-plain-${new Date().toISOString().slice(0, 10)}.json`);
  await stampExport();
}

/**
 * Import from a parsed backup file. mode: "merge" | "replace".
 * For PIN-mode encrypted backups, `pin` unlocks them by re-deriving the key from
 * `data.salt` (legacy format — still the only way to open older exports). No-PIN
 * backups carry their own device key (`data.deviceKey`) and need no PIN at all.
 */
export async function importBackup(data, mode, pin = null) {
  let payload = null;
  if (!data || data.type !== "batwa-backup") throw new Error("Not a Batwa backup file");
  if (data.encrypted) {
    if (!data.cipher || !(data.salt || data.deviceKey)) throw new Error("Backup file is damaged");
    let key;
    if (data.deviceKey) {
      try {
        key = await importRawKey(data.deviceKey);
      } catch {
        throw new Error("Backup file is damaged");
      }
    } else {
      if (!pin) throw new Error("pin-needed");
      key = await deriveKey(pin, data.salt);
    }
    try {
      payload = await decrypt(key, data.cipher);
    } catch {
      throw new Error(data.deviceKey ? "Couldn't decrypt this backup" : "Wrong PIN for this backup");
    }
  } else {
    payload = {
      entries: data.entries || [],
      accounts: data.accounts || [],
      spaces: data.spaces || [],
      contacts: data.contacts || {},
      profile: data.profile || null,
    };
  }
  if (mode === "replace") await replaceAll(payload);
  else return mergeData(payload);
  return (payload.entries || []).length;
}
