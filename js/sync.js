// JSONBin.io sync: push/pull the ENCRYPTED blob only. Plus manual export/import.
// Sync is an enhancement — every failure degrades gracefully, never blocks.

import { dbGet, dbPut, getMeta, setMeta } from "./db.js";
import { getKey } from "./auth.js";
import { decrypt, deriveKey } from "./crypto.js";
import { state, replaceAll, mergeData } from "./ledger.js";
import { timeAgo } from "./util/format.js";
import { toast } from "./ui/toast.js";
import { chooseSheet, confirmSheet, sheetOpen } from "./ui/modals.js";

const API = "https://api.jsonbin.io/v3/b";

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
  const res = await fetch(`${API}/${binId}/latest`, {
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
  const res = await fetch(`${API}/${binId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": masterKey },
    body: JSON.stringify(payload),
  });
  if (res.status === 401 || res.status === 403) throw new Error("bad-key");
  if (res.status === 429) throw new Error("rate-limit");
  if (!res.ok) throw new Error("http-" + res.status);
}

async function buildPayload() {
  const blob = await dbGet("entries", "blob");
  return {
    app: "batwa",
    version: 1,
    updatedAt: (await getMeta("updatedAt")) || new Date().toISOString(),
    salt: await getMeta("pinSalt"), // same PIN restores on a new device
    cipher: blob || null,
  };
}

async function pullRemote(remote) {
  if (!remote?.cipher) return false;
  const localSalt = await getMeta("pinSalt");
  let key = getKey();
  if (remote.salt && remote.salt !== localSalt) {
    // Blob was encrypted under a different salt (other device) — same PIN, different key.
    toast("Remote data uses a different device key — import it via a backup file instead", { icon: "⚠️" });
    return false;
  }
  try {
    const data = await decrypt(key, remote.cipher);
    await replaceAll(data);
    await setMeta("updatedAt", remote.updatedAt);
    return true;
  } catch {
    toast("Couldn't decrypt remote data with this PIN", { icon: "⚠️" });
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
  if (!navigator.onLine) { if (!silent) toast("You're offline — sync will run when you're back", { icon: "📡" }); return; }
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
        if (await pullRemote(remote)) toast("Cloud copy restored", { icon: "☁️" });
      } else if (pick === "local") {
        await remotePut(binId, masterKey, await buildPayload());
        toast("Pushed this device's data", { icon: "☁️" });
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
        if (await pullRemote(remote)) toast("Up to date with cloud", { icon: "☁️" });
      } else return;
    } else if (localChanged || !remoteUpdated) {
      await remotePut(binId, masterKey, await buildPayload());
      if (!silent) toast("Synced", { icon: "☁️" });
    } else if (!silent) {
      toast("Already up to date", { icon: "✅" });
    }

    await setMeta("lastSyncedAt", new Date().toISOString());
    lastError = null;
  } catch (err) {
    lastError = err.message;
    const msg = ERRORS[err.message] || "Sync failed — will retry later";
    if (!silent) toast(msg, { icon: "⚠️" });
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

export async function exportEncrypted() {
  const blob = await dbGet("entries", "blob");
  downloadJSON({
    type: "batwa-backup",
    encrypted: true,
    exportedAt: new Date().toISOString(),
    salt: await getMeta("pinSalt"),
    cipher: blob,
    categories: state.categories,
  }, `batwa-backup-${new Date().toISOString().slice(0, 10)}.json`);
}

export async function exportPlain() {
  downloadJSON({
    type: "batwa-backup",
    encrypted: false,
    exportedAt: new Date().toISOString(),
    entries: state.entries,
    accounts: state.accounts,
    categories: state.categories,
  }, `batwa-plain-${new Date().toISOString().slice(0, 10)}.json`);
}

/**
 * Import from a parsed backup file. mode: "merge" | "replace".
 * For encrypted backups, `pin` unlocks them (defaults to trying the current key's PIN salt).
 */
export async function importBackup(data, mode, pin = null) {
  let payload = null;
  if (!data || data.type !== "batwa-backup") throw new Error("Not a Batwa backup file");
  if (data.encrypted) {
    if (!data.cipher || !data.salt) throw new Error("Backup file is damaged");
    if (!pin) throw new Error("pin-needed");
    const key = await deriveKey(pin, data.salt);
    try {
      payload = await decrypt(key, data.cipher);
    } catch {
      throw new Error("Wrong PIN for this backup");
    }
  } else {
    payload = { entries: data.entries || [], accounts: data.accounts || [] };
  }
  if (mode === "replace") await replaceAll(payload);
  else return mergeData(payload);
  return (payload.entries || []).length;
}
