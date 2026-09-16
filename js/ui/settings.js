// Settings: sync config, backup, PIN, categories, install, about.

import { $, el, esc, anim } from "../util/dom.js";
import { state, saveCategories, saveLimits } from "../ledger.js";
import { changePin, disablePin, enablePin, getKeyMode, enrollBiometricWithPin } from "../auth.js";
import { bioAvailable, isBioEnrolled, removeBio } from "../biometric.js";
import { openSheet, closeSheet, confirmSheet, chooseSheet } from "./modals.js";
import { toast } from "./toast.js";
import {
  getSyncConfig, setSyncConfig, syncNow, syncStatusText,
  exportEncrypted, exportPlain, importBackup, onSyncState, STARTER_JSON, getLastExportAt,
} from "../sync.js";
import { remindersState, enableReminders, disableReminders, sendTestReminder } from "../reminders.js";
import { shortDate } from "../util/format.js";
import { manageAccountsSheet } from "./accounts.js";
import { icon, catIcon } from "./icons.js";
import { getInstallState, promptInstall } from "../app.js";
import { getThemeMode, setThemeMode, themeLabel, resolvedTheme } from "../theme.js";

const ICONS = {
  sync:    ["cloud",       "var(--c-aqua-soft)",   "#0B87B8"],
  now:     ["refresh",     "var(--c-violet-soft)", "var(--c-violet)"],
  exp:     ["upload",      "var(--c-pos-soft)",    "var(--c-pos)"],
  imp:     ["download",    "var(--c-warn-soft)",   "var(--c-warn)"],
  pin:     ["lock",        "var(--c-violet-soft)", "var(--c-violet)"],
  bio:     ["fingerprint", "var(--c-aqua-soft)",   "#0B87B8"],
  pinoff:  ["alert",       "var(--c-neg-soft)",    "var(--c-neg)"],
  cat:     ["tag",         "var(--c-aqua-soft)",   "#0B87B8"],
  acc:     ["credit-card", "var(--c-violet-soft)", "var(--c-violet)"],
  install: ["smartphone",  "var(--c-pos-soft)",    "var(--c-pos)"],
  rem:     ["clock",       "var(--c-warn-soft)",   "var(--c-warn)"],
  remtest: ["sparkles",    "var(--c-violet-soft)", "var(--c-violet)"],
  theme:   ["moon",        "var(--c-violet-soft)", "var(--c-violet)"],
};

function row(key, label, value, onClick) {
  const [name, bg, fg] = ICONS[key];
  const r = el("button", { class: "set-row", onclick: onClick });
  r.innerHTML = `
    <span class="set-ico" style="background:${bg};color:${fg}">${icon(name, 18)}</span>
    <span>${label}</span>
    ${value ? `<span class="set-val">${value}</span>` : '<span class="chev">›</span>'}
  `;
  return r;
}

let _view = null;
/** Re-paint settings in place after the PIN mode changes. */
function refresh() {
  if (_view && _view.isConnected) renderSettings(_view);
}

export function renderSettings(view) {
  _view = view;
  const pinOn = getKeyMode() === "pin";
  view.innerHTML = "";

  // ---- Accounts ----
  const accG = el("div", { class: "set-group" });
  accG.append(el("h2", {}, "Accounts"));
  accG.append(el("div", { class: "card set-card" },
    row("acc", "Manage accounts", `${state.accounts.length}`, manageAccountsSheet)));
  view.append(accG);

  // ---- Cloud sync ----
  const syncGroup = el("div", { class: "set-group" });
  syncGroup.append(el("h2", {}, "Cloud sync"));
  const syncCard = el("div", { class: "card set-card" });
  const statusLine = el("div", { class: "sync-status", style: "padding:12px 16px 4px" });
  statusLine.innerHTML = '<span class="sync-dot"></span><span>…</span>';
  refreshStatus(statusLine);
  onSyncState(() => refreshStatus(statusLine));
  syncCard.append(
    statusLine,
    row("now", "Sync now", "", () => syncNow()),
    row("sync", "JSONBin setup", "", syncSetupSheet),
  );
  syncGroup.append(syncCard, el("p", { class: "xsmall muted", style: "margin-top:8px;padding:0 4px" },
    pinOn
      ? "Only the encrypted blob is uploaded — another device needs this PIN to restore it. Your JSONBin keys live in this app's storage, so don't share your deployed URL publicly if the bin is private."
      : "Only the encrypted blob is uploaded, with its key inside — any device with your Bin ID and master key can restore it, so treat those credentials like a password (or set up a PIN for stronger protection)."));
  view.append(syncGroup);

  // ---- Backup ----
  const bk = el("div", { class: "set-group" });
  bk.append(el("h2", {}, "Backup"));
  const expRow = row("exp", "Export data", "…", exportSheet);
  bk.append(el("div", { class: "card set-card" }, expRow, row("imp", "Import from file", "", importSheet)));
  view.append(bk);
  paintExportValue(expRow);

  // ---- Reminders ----
  const rem = el("div", { class: "set-group" });
  rem.append(el("h2", {}, "Reminders"));
  const remCard = el("div", { class: "card set-card" });
  const remSlot = row("rem", "Bill reminders", "…", () => {});
  const testRow = row("remtest", "Send a test reminder", "", async () => {
    const res = await sendTestReminder();
    toast(res.ok ? "Sent — check your notification shade" : res.reason,
      { icon: icon(res.ok ? "check-circle" : "alert", 18) });
  });
  remCard.append(remSlot, testRow);
  rem.append(remCard, el("p", { class: "xsmall muted", style: "margin-top:8px;padding:0 4px" },
    "Reminders run in the background even when Batwa is closed. To do that, only the due dates and how many bills fall on each are kept outside the encrypted ledger — never titles or amounts. Android decides how often it runs (usually once or twice a day) and only for apps you actually use."));
  view.append(rem);
  paintRemindersRow(remSlot, testRow);

  // ---- Security ----
  const sec = el("div", { class: "set-group" });
  sec.append(el("h2", {}, "Security"));
  const secCard = el("div", { class: "card set-card" });
  // placeholder: the real row needs IndexedDB + the platform authenticator,
  // and it has to sit in the card's sibling order for the dividers to work
  const bioSlot = row("bio", "Fingerprint unlock", "…", () => {});
  const bioNote = el("div");
  if (pinOn) {
    secCard.append(
      bioSlot,
      row("pin", "Change PIN", "", changePinSheet),
      row("pinoff", "Disable PIN", "", disablePinSheet),
    );
  } else {
    secCard.append(row("pin", "Set up a PIN", "Off", setupPinSheet));
  }
  sec.append(secCard, bioNote);
  const warn = el("div", {
    class: "warn-card", style: "margin-top:12px",
    html: pinOn
      ? `${icon("alert", 15)} There is no PIN recovery. Your PIN is the encryption key — if you forget it, the data is gone. Keep an export backup somewhere safe.`
      : `${icon("alert", 15)} Batwa opens without asking for anything. Your data is still encrypted on disk with a device key, but anyone who can unlock this phone can read every amount.`,
  });
  sec.append(warn);
  view.append(sec);
  if (pinOn) paintBioRow(bioSlot, bioNote, warn);

  // ---- Appearance ----
  const appg = el("div", { class: "set-group" });
  appg.append(el("h2", {}, "Appearance"));
  appg.append(el("div", { class: "card set-card" },
    row("theme", "Theme", themeLabel(), themeSheet)));
  view.append(appg);

  // ---- Categories ----
  const cats = el("div", { class: "set-group" });
  cats.append(el("h2", {}, "Categories"));
  cats.append(el("div", { class: "card set-card" },
    row("cat", "Edit categories", `${state.categories.length}`, categoriesSheet)));
  view.append(cats);

  // ---- Install ----
  const inst = getInstallState();
  if (inst !== "standalone") {
    const g = el("div", { class: "set-group" });
    g.append(el("h2", {}, "App"));
    const card = el("div", { class: "card set-card" });
    if (inst === "installable") {
      card.append(row("install", "Install app", "", promptInstall));
    } else if (inst === "ios") {
      card.append(el("div", { style: "padding:14px 16px" },
        el("div", { class: "strong small", html: `${icon("smartphone", 14)} Install on iPhone` }),
        el("p", { class: "xsmall muted", style: "margin-top:4px" },
          "Open the Share menu in Safari, then tap “Add to Home Screen”. Batwa will open full-screen and work offline."),
      ));
    } else {
      card.append(el("div", { style: "padding:14px 16px" },
        el("p", { class: "xsmall muted" }, "Open this page in your phone's browser to install Batwa to the home screen."),
      ));
    }
    g.append(card);
    view.append(g);
  }

  view.append(el("p", { class: "xsmall muted", style: "text-align:center;padding:12px 0 4px" },
    "Batwa · your money never leaves your device unencrypted"));

  anim(view.children, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, stagger: 0.06, ease: "power2.out" });
}

/* ---- backup + reminders rows (both resolve asynchronously) ---- */

async function paintExportValue(r) {
  if (!r.isConnected) return;
  let at = null;
  try { at = await getLastExportAt(); } catch {}
  const val = r.querySelector(".set-val");
  if (val) val.textContent = at ? `Last: ${shortDate(String(at).slice(0, 10))}` : "Never";
}

/**
 * Chrome only exposes periodic sync to an installed PWA, and the permission can
 * be revoked from Android settings behind our back — so this re-reads the real
 * state on every paint rather than trusting the stored flag alone.
 */
async function paintRemindersRow(slot, testRow) {
  if (!slot.isConnected) return;
  const st = await remindersState();
  const value = st === "on" ? "On" : st === "off" ? "Off" : "Unavailable";

  const turnOn = async () => {
    const res = await enableReminders();
    toast(res.ok ? "Bill reminders are on" : res.reason, { icon: icon(res.ok ? "clock" : "alert", 18) });
    refresh();
  };
  const turnOff = async () => {
    await disableReminders();
    toast("Bill reminders are off", { icon: icon("clock", 18) });
    refresh();
  };

  const r = row("rem", "Bill reminders", value, st === "on" ? turnOff : st === "off" ? turnOn : () => {});
  if (st !== "on" && st !== "off") r.disabled = true;
  slot.replaceWith(r);
  testRow.disabled = st !== "on";

  if (st === "not-installed") {
    r.insertAdjacentElement("afterend", el("div", { style: "padding:0 16px 12px" },
      el("p", { class: "xsmall muted" }, "Install Batwa to the home screen first — Chrome only runs background sync for an installed app.")));
  } else if (st === "off") {
    let perm = "default";
    try { perm = Notification.permission; } catch {}
    if (perm === "denied") {
      r.insertAdjacentElement("afterend", el("div", { style: "padding:0 16px 12px" },
        el("p", { class: "xsmall muted" }, "Allow notifications for Batwa in Android settings.")));
    }
  }
}

/* ---- fingerprint unlock ---- */

/**
 * The row can only be decided asynchronously (IndexedDB + the platform
 * authenticator), so it lands in a slot the sync render left behind.
 */
async function paintBioRow(slot, note, warn) {
  if (!slot.isConnected) return;
  if (!(await bioAvailable())) {
    const dead = row("bio", "Fingerprint unlock", "Unavailable", () => {});
    dead.disabled = true;
    slot.replaceWith(dead);
    note.replaceChildren(el("p", { class: "xsmall muted", style: "margin-top:8px;padding:0 4px" },
      "This device doesn't offer a fingerprint Batwa can lock a key with, so the PIN is the only way in."));
    return;
  }
  const on = await isBioEnrolled();
  slot.replaceWith(row("bio", "Fingerprint unlock", on ? "On" : "Off",
    on ? manageBioSheet : enableBioSheet));
  if (on) {
    warn.insertAdjacentHTML("beforeend",
      " Fingerprint unlock is a convenience on top of the PIN, not a replacement — the PIN is still the only recovery.");
  }
}

/** Turning it on needs the PIN: the key it wraps can only come from the PIN. */
function enableBioSheet() {
  openSheet("Fingerprint unlock", (body) => {
    const pin = pinInput("Current PIN");
    const msg = el("div", { class: "field-error", style: "display:block;min-height:20px" });
    const go = el("button", { class: "btn btn-primary" }, "Turn on");
    let busy = false;
    go.addEventListener("click", async () => {
      if (busy) return;
      msg.textContent = "";
      if (!/^\d{4}$/.test(pin.value)) { msg.textContent = "Enter your current 4-digit PIN"; return; }
      busy = true; go.disabled = true;
      const res = await enrollBiometricWithPin(pin.value);
      busy = false; go.disabled = false;
      if (!res.ok) { msg.textContent = res.reason; return; }
      closeSheet();
      refresh();
      toast("Fingerprint unlock is on", { icon: icon("fingerprint", 18) });
    });
    body.append(
      el("p", { class: "small muted", style: "margin-bottom:14px" },
        "Your fingerprint unlocks a sealed copy of the PIN key kept on this device — the PIN itself is never stored and still opens Batwa. You may be asked for your fingerprint twice while it's being set up."),
      el("div", { class: "field" }, el("label", {}, "Current PIN"), pin),
      msg,
      el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => closeSheet() }, "Cancel"),
        go,
      ),
    );
  });
}

/** Turning it off is just a delete — no PIN, no re-encryption, no data touched. */
function manageBioSheet() {
  openSheet("Fingerprint unlock", (body) => {
    const off = el("button", { class: "btn btn-soft-danger" }, "Turn off");
    off.addEventListener("click", async () => {
      await removeBio();
      closeSheet();
      refresh();
      toast("Fingerprint unlock is off", { icon: icon("fingerprint", 18) });
    });
    body.append(
      el("p", { class: "small muted", style: "margin-bottom:14px" },
        "Batwa opens with your fingerprint, falling back to the keypad whenever you cancel."),
      el("div", {
        class: "warn-card", style: "margin-bottom:14px",
        html: `${icon("alert", 15)} Removing it never touches your data or your PIN. To use it again you'll need your PIN once.`,
      }),
      el("p", { class: "xsmall muted", style: "margin-bottom:14px" },
        "The passkey itself may be backed up by your phone's password manager, but the sealed key and its salt never leave this device's storage."),
      el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => closeSheet() }, "Close"),
        off,
      ),
    );
  });
}

/** Just turned a PIN on, and the PIN is still in hand — offer the fingerprint. */
async function offerBioAfterPin(pin) {
  if (!(await bioAvailable())) return;
  const yes = await chooseSheet({
    title: "Add fingerprint unlock?",
    message: "Open Batwa with a touch. Your PIN still works and is still the key.",
    options: [
      { label: "Use fingerprint", value: "yes", style: "btn-primary" },
      { label: "Not now", value: "no" },
    ],
  });
  if (yes !== "yes") return;
  const res = await enrollBiometricWithPin(pin);
  refresh();
  toast(res.ok ? "Fingerprint unlock is on" : res.reason, { icon: icon(res.ok ? "fingerprint" : "alert", 18) });
}

async function refreshStatus(node) {
  const s = await syncStatusText();
  node.className = `sync-status ${s.cls}`;
  node.innerHTML = `<span class="sync-dot"></span><span>${s.text}</span>`;
}

/* ---- sheets ---- */

async function syncSetupSheet() {
  const cfg = await getSyncConfig();
  openSheet("JSONBin setup", (body) => {
    const bin = el("input", { class: "input", type: "text", placeholder: "Bin ID", value: cfg.binId, autocomplete: "off" });
    const key = el("input", { class: "input", type: "password", placeholder: "X-Master-Key", value: cfg.masterKey, autocomplete: "off" });
    const starter = el("div", { class: "copy-box" });
    starter.append(
      el("code", { class: "grow" }, STARTER_JSON),
      el("button", {
        class: "btn btn-sm btn-ghost", type: "button",
        onclick: async (e) => {
          try { await navigator.clipboard.writeText(STARTER_JSON); e.target.textContent = "Copied ✓"; }
          catch { e.target.textContent = "Select + copy manually"; }
          setTimeout(() => (e.target.textContent = "Copy"), 2000);
        },
      }, "Copy"),
    );
    body.append(
      el("p", { class: "small muted", style: "margin-bottom:14px" },
        "Create a free bin at jsonbin.io — bins can't be blank, so paste this starter JSON into it, then enter the Bin ID and your master key below. Batwa only ever uploads the encrypted blob."),
      starter,
      el("div", { class: "field" }, el("label", {}, "Bin ID"), bin),
      el("div", { class: "field" }, el("label", {}, "Master key"), key),
      el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => closeSheet() }, "Cancel"),
        el("button", {
          class: "btn btn-primary",
          onclick: async () => {
            await setSyncConfig(bin.value, key.value);
            closeSheet();
            toast("Sync settings saved", { icon: icon("cloud", 18) });
            if (bin.value && key.value) syncNow();
          },
        }, "Save"),
      ),
    );
  });
}

async function exportSheet() {
  const pick = await chooseSheet({
    title: "Export data",
    message: "Encrypted keeps your data protected the same way the app protects it on this device. Plain is readable by anyone who opens the file.",
    options: [
      { label: "Encrypted backup (recommended)", value: "enc", style: "btn-primary" },
      { label: "Plain JSON (unprotected)", value: "plain" },
    ],
  });
  if (pick === "enc") { await exportEncrypted(); toast("Encrypted backup downloaded", { icon: icon("upload", 18) }); }
  if (pick === "plain") {
    const ok = await confirmSheet({
      title: "Export without encryption?",
      message: "Anyone with this file can read every amount. Store it carefully.",
      confirmLabel: "Export plain",
      danger: true,
    });
    if (ok) { await exportPlain(); toast("Plain backup downloaded", { icon: icon("upload", 18) }); }
  }
}

function importSheet() {
  const input = el("input", { type: "file", accept: ".json,application/json", style: "display:none" });
  document.body.append(input);
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { toast("That file isn't valid JSON", { icon: icon("alert", 18) }); return; }

    const mode = await chooseSheet({
      title: "Import backup",
      message: "Merge keeps everything you have and adds entries from the file. Replace wipes this device's data first.",
      options: [
        { label: "Merge with current data", value: "merge", style: "btn-primary" },
        { label: "Replace everything", value: "replace", style: "btn-soft-danger" },
      ],
    });
    if (!mode) return;
    if (mode === "replace") {
      const sure = await confirmSheet({
        title: "Replace all data?",
        message: "Every entry on this device will be deleted and replaced by the file. This cannot be undone.",
        confirmLabel: "Replace",
        danger: true,
      });
      if (!sure) return;
    }

    const run = async (pin) => {
      try {
        const n = await importBackup(data, mode, pin);
        toast(mode === "merge" ? `Imported ${n} new entr${n === 1 ? "y" : "ies"}` : "Data replaced from backup", { icon: icon("download", 18) });
      } catch (err) {
        if (err.message === "pin-needed") askBackupPin(run);
        else toast(err.message, { icon: icon("alert", 18) });
      }
    };
    run(null);
  });
  input.click();
}

function askBackupPin(cb) {
  openSheet("Backup PIN", (body) => {
    const pin = el("input", { class: "input", type: "password", inputmode: "numeric", maxlength: "4", placeholder: "••••", autocomplete: "off", style: "text-align:center;letter-spacing:10px;font-size:1.4rem" });
    body.append(
      el("p", { class: "small muted", style: "margin-bottom:14px" }, "This backup is encrypted. Enter the PIN it was created with."),
      el("div", { class: "field" }, pin),
      el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => closeSheet() }, "Cancel"),
        el("button", { class: "btn btn-primary", onclick: () => { const v = pin.value; closeSheet(); cb(v); } }, "Unlock backup"),
      ),
    );
  });
}

const pinInput = (ph) => el("input", {
  class: "input", type: "password", inputmode: "numeric", maxlength: "4",
  placeholder: ph, autocomplete: "off",
  style: "text-align:center;letter-spacing:10px;font-size:1.4rem",
});

function changePinSheet() {
  openSheet("Change PIN", (body) => {
    const mk = pinInput;
    const oldP = mk("Current PIN"), n1 = mk("New PIN"), n2 = mk("Repeat new PIN");
    const msg = el("div", { class: "field-error", style: "display:block;min-height:20px" });
    body.append(
      el("div", { class: "field" }, el("label", {}, "Current PIN"), oldP),
      el("div", { class: "field" }, el("label", {}, "New PIN"), n1),
      el("div", { class: "field" }, el("label", {}, "Repeat new PIN"), n2),
      msg,
      el("div", { class: "warn-card", style: "margin-bottom:14px" }, "Changing your PIN re-encrypts all data. Remember it — there's no recovery."),
      el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => closeSheet() }, "Cancel"),
        el("button", {
          class: "btn btn-primary",
          onclick: async () => {
            msg.textContent = "";
            if (!/^\d{4}$/.test(n1.value)) { msg.textContent = "New PIN must be 4 digits"; return; }
            if (n1.value !== n2.value) { msg.textContent = "New PINs don't match"; return; }
            const res = await changePin(oldP.value, n1.value);
            if (!res.ok) { msg.textContent = res.reason; return; }
            closeSheet();
            refresh();
            toast(res.bioDropped
              ? "PIN changed. Fingerprint unlock was turned off — turn it on again in Settings"
              : "PIN changed — data re-encrypted", { icon: icon("lock", 18) });
          },
        }, "Change PIN"),
      ),
    );
  });
}

/** PIN -> no PIN. Requires the current PIN, then re-keys the ledger. */
function disablePinSheet() {
  openSheet("Disable PIN", (body) => {
    const oldP = pinInput("Current PIN");
    const msg = el("div", { class: "field-error", style: "display:block;min-height:20px" });
    const go = el("button", { class: "btn btn-soft-danger" }, "Remove PIN");
    let busy = false;
    go.addEventListener("click", async () => {
      if (busy) return;
      msg.textContent = "";
      if (!/^\d{4}$/.test(oldP.value)) { msg.textContent = "Enter your current 4-digit PIN"; return; }
      busy = true;
      go.disabled = true;
      const res = await disablePin(oldP.value);
      busy = false;
      go.disabled = false;
      if (!res.ok) { msg.textContent = res.reason; return; }
      closeSheet();
      refresh();
      toast("PIN removed — Batwa now opens straight away", { icon: icon("alert", 18) });
    });
    body.append(
      el("p", { class: "small muted", style: "margin-bottom:14px" },
        "Batwa will re-encrypt everything under a random key kept in this app's storage, so it can open without asking you for anything."),
      el("div", { class: "field" }, el("label", {}, "Current PIN"), oldP),
      msg,
      el("div", {
        class: "warn-card", style: "margin-bottom:14px",
        html: `${icon("alert", 15)} Anyone who can unlock this phone will be able to open Batwa and see every amount. You'll also lose encrypted backups and cloud restore on other devices — export a copy first if you rely on those.`,
      }),
      el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => closeSheet() }, "Cancel"),
        go,
      ),
    );
  });
}

/** No PIN -> PIN. Re-encrypts from the device key, then removes it. */
function setupPinSheet() {
  openSheet("Set up a PIN", (body) => {
    const n1 = pinInput("New PIN"), n2 = pinInput("Repeat new PIN");
    const msg = el("div", { class: "field-error", style: "display:block;min-height:20px" });
    const go = el("button", { class: "btn btn-primary" }, "Turn on PIN");
    let busy = false;
    go.addEventListener("click", async () => {
      if (busy) return;
      msg.textContent = "";
      if (!/^\d{4}$/.test(n1.value)) { msg.textContent = "PIN must be 4 digits"; return; }
      if (n1.value !== n2.value) { msg.textContent = "PINs don't match"; return; }
      busy = true;
      go.disabled = true;
      const res = await enablePin(n1.value);
      busy = false;
      go.disabled = false;
      if (!res.ok) { msg.textContent = res.reason; return; }
      const pin = n1.value;
      closeSheet();
      refresh();
      toast("PIN is on — data re-encrypted", { icon: icon("lock", 18) });
      offerBioAfterPin(pin);
    });
    body.append(
      el("p", { class: "small muted", style: "margin-bottom:14px" },
        "Batwa will ask for this PIN every time it opens, and re-encrypt your data with it. You can add fingerprint unlock after the PIN is on."),
      el("div", { class: "field" }, el("label", {}, "New PIN"), n1),
      el("div", { class: "field" }, el("label", {}, "Repeat new PIN"), n2),
      msg,
      el("div", { class: "warn-card", style: "margin-bottom:14px" },
        "There is no PIN recovery. Your PIN becomes the encryption key — if you forget it, the data is gone."),
      el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => closeSheet() }, "Cancel"),
        go,
      ),
    );
  });
}

function categoriesSheet() {
  openSheet("Categories", (body) => {
    const wrap = el("div", { class: "cat-limit-list" });
    const draft = { ...state.limits };

    const paint = () => {
      wrap.replaceChildren();
      for (const c of state.categories) {
        const limitInput = el("input", {
          class: "input input-sm", type: "text", inputmode: "numeric",
          autocomplete: "off", placeholder: "No limit",
          "aria-label": `Monthly limit for ${c}`,
          value: draft[c] ? String(draft[c]) : "",
        });
        // digits only; empty clears the limit. Saved on change, never per keystroke.
        limitInput.addEventListener("change", async () => {
          const clean = limitInput.value.replace(/[^0-9]/g, "");
          limitInput.value = clean;
          if (clean && Number(clean) > 0) draft[c] = Number(clean);
          else delete draft[c];
          await saveLimits(draft);
        });

        const rowEl = el("div", { class: "cat-limit-row" },
          el("span", { class: "cat-limit-ico", html: catIcon(c, 15) }),
          el("span", { class: "small strong truncate" }, c),
          el("span", { class: "cat-limit-field" }, el("span", { class: "cat-limit-cur" }, "Rs"), limitInput),
        );
        if (c !== "Others") {
          rowEl.append(el("button", {
            class: "cat-x", "aria-label": `Remove ${c}`,
            onclick: async () => {
              delete draft[c];
              await saveCategories(state.categories.filter((x) => x !== c));
              paint();
            },
            html: icon("x", 13),
          }));
        } else {
          rowEl.append(el("span", { class: "cat-x-spacer" }));
        }
        wrap.append(rowEl);
      }
    };
    paint();

    const inp = el("input", { class: "input", type: "text", placeholder: "New category…", maxlength: "24" });
    const add = el("button", {
      class: "btn btn-primary", style: "flex:0 0 auto;min-width:90px",
      onclick: async () => {
        const v = inp.value.trim();
        if (!v) return;
        if (state.categories.some((c) => c.toLowerCase() === v.toLowerCase())) { toast("Already exists"); return; }
        await saveCategories([...state.categories.filter((c) => c !== "Others"), v, "Others"]);
        inp.value = "";
        paint();
      },
    }, "Add");

    body.append(
      el("p", { class: "small muted", style: "margin-bottom:12px" },
        "Set a monthly limit to see how a category is tracking in Reports and on Home. Leave it blank for no limit. “Others” always stays — it's the fallback for anything deleted."),
      wrap,
      el("div", { class: "row", style: "margin-top:16px" }, el("div", { class: "grow" }, inp), add),
    );
  });
}

/** Light / dark / follow the phone. Applies instantly, no reload. */
async function themeSheet() {
  const current = getThemeMode();
  const mark = (m, label) => (m === current ? `✓ ${label}` : label);
  const pick = await chooseSheet({
    title: "Theme",
    message: "Dark uses the same colours, dimmed for a dark room. System follows your phone.",
    options: [
      { value: "system", label: mark("system", "Follow system"), style: current === "system" ? "btn-primary" : "btn-ghost" },
      { value: "light",  label: mark("light", "Light"),          style: current === "light" ? "btn-primary" : "btn-ghost" },
      { value: "dark",   label: mark("dark", "Dark"),            style: current === "dark" ? "btn-primary" : "btn-ghost" },
    ],
  });
  if (!pick || pick === current) return;
  setThemeMode(pick);
  toast(`Theme: ${themeLabel(pick)}`, { icon: icon(resolvedTheme() === "dark" ? "moon" : "sun", 18) });
  refresh();
}
