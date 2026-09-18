// Settings: sync config, backup, PIN, categories, install, about.

import { $, el, esc, anim, buzz } from "../util/dom.js";
import { state, saveLimits, deleteCategory, countInCategory, RESERVED_CATEGORY } from "../ledger.js";
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
import { categoryEditorPanel } from "./catedit.js";
import { getInstallState, promptInstall } from "../app.js";
import { getThemeMode, setThemeMode, themeLabel, resolvedTheme, onThemeChange } from "../theme.js";
import { renderSpacesSettings } from "./spaces.js";
import { APP_VERSION } from "../config.js";

const REPO_URL = "https://github.com/zubairbinshaukat/batwa";
const AUTHOR_URL = "https://zubyr.dev";

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
  info:    ["info",        "var(--c-aqua-soft)",   "#0B87B8"],
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

  // Every group goes into this wrapper, never straight into `view`: on desktop
  // it becomes a two-column grid, and the stagger animates its children.
  const grid = el("div", { class: "set-grid" });
  view.append(grid);

  // ---- 1. Money ----
  const money = el("div", { class: "set-group" });
  money.append(el("h2", {}, "Money"));
  money.append(el("div", { class: "card set-card" },
    row("acc", "Manage accounts", `${state.accounts.length}`, manageAccountsSheet),
    row("cat", "Edit categories", `${state.categories.length}`, categoriesSheet)));
  grid.append(money);

  // ---- 2. Shared spaces ----
  // The one shared surface that exists with zero spaces: it is where the first
  // one is made. It shows no space data until there is a space (plan §0).
  renderSpacesSettings(grid, { refresh });

  // ---- 3. Security & privacy ----
  const sec = el("div", { class: "set-group" });
  sec.append(el("h2", {}, "Security & privacy"));
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
  grid.append(sec);
  if (pinOn) paintBioRow(bioSlot, bioNote, warn);

  // ---- 4. Backup & sync ----
  // Cloud sync and file backup are the same job to a user: getting the ledger
  // off this phone. The two long grey paragraphs that used to sit under here
  // now live in one sheet behind "How your data is protected".
  const bk = el("div", { class: "set-group" });
  bk.append(el("h2", {}, "Backup & sync"));
  const bkCard = el("div", { class: "card set-card" });
  const statusLine = el("div", { class: "sync-status", style: "padding:12px 16px 4px" });
  statusLine.innerHTML = '<span class="sync-dot"></span><span>…</span>';
  refreshStatus(statusLine);
  onSyncState(() => refreshStatus(statusLine));
  const expRow = row("exp", "Export data", "…", exportSheet);
  bkCard.append(
    statusLine,
    row("now", "Sync now", "", () => syncNow()),
    row("sync", "Cloud sync setup", "", syncSetupSheet),
    expRow,
    row("imp", "Import from file", "", importSheet),
    row("info", "How your data is protected", "", () => privacySheet(getKeyMode() === "pin")),
  );
  bk.append(bkCard);
  grid.append(bk);
  paintExportValue(expRow);

  // ---- 5. Notifications ----
  const rem = el("div", { class: "set-group" });
  rem.append(el("h2", {}, "Notifications"));
  const remCard = el("div", { class: "card set-card" });
  const remSlot = row("rem", "Bill reminders", "…", () => {});
  const testRow = row("remtest", "Send a test reminder", "", async () => {
    const res = await sendTestReminder();
    toast(res.ok ? "Sent — check your notification shade" : res.reason,
      { icon: icon(res.ok ? "check-circle" : "alert", 18) });
  });
  remCard.append(remSlot, testRow);
  rem.append(remCard);
  grid.append(rem);
  paintRemindersRow(remSlot, testRow);

  // ---- 6. App (theme + install) ----
  const appg = el("div", { class: "set-group" });
  appg.append(el("h2", {}, "App"));
  const appCard = el("div", { class: "card set-card" });
  const themeRow = row("theme", "Theme", themeLabel(), themeSheet);
  appCard.append(themeRow);
  const inst = getInstallState();
  if (inst === "installable") {
    appCard.append(row("install", "Install app", "", promptInstall));
  } else if (inst === "ios") {
    appCard.append(el("div", { style: "padding:14px 16px" },
      el("div", { class: "strong small", html: `${icon("smartphone", 14)} Install on iPhone` }),
      el("p", { class: "xsmall muted", style: "margin-top:4px" },
        "Open the Share menu in Safari, then tap “Add to Home Screen”. Batwa will open full-screen and work offline."),
    ));
  } else if (inst !== "standalone") {
    appCard.append(el("div", { style: "padding:14px 16px" },
      el("p", { class: "xsmall muted" }, "Open this page in your phone's browser to install Batwa to the home screen."),
    ));
  }
  appg.append(appCard);
  grid.append(appg);
  // the header toggle can flip the theme while this screen is open
  const offTheme = onThemeChange(() => {
    if (!themeRow.isConnected) { offTheme(); return; }
    const val = themeRow.querySelector(".set-val");
    if (val) val.textContent = themeLabel();
  });

  // ---- 7. About footer ----
  grid.append(aboutFooter());

  anim(grid.children, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, stagger: 0.06, ease: "power2.out" });
}

/**
 * Who made this, where the code is, and where to read more. The avatar is a
 * transparent cut-out, so the lavender plate behind it comes from CSS and
 * follows the theme. Both links open outside the installed window — navigating
 * the PWA itself away to GitHub has no back button.
 */
function aboutFooter() {
  const about = el("div", { class: "set-about" });

  const avatar = el("img", {
    class: "set-avatar", src: "icons/author-192.webp",
    srcset: "icons/author-384.webp 2x",
    width: "72", height: "72", alt: "Zubair bin Shaukat",
    loading: "lazy", decoding: "async",
  });
  // The asset may not exist yet (or may fail on a stale cache): fall back to a
  // plain initials chip rather than a broken-image icon.
  avatar.addEventListener("error", () => {
    avatar.replaceWith(el("div", {
      class: "set-avatar set-avatar-fb", role: "img", "aria-label": "Zubair bin Shaukat",
    }, "ZS"));
  });

  const link = (label, href, iconName) => el("a", {
    class: "btn btn-ghost btn-sm", href, target: "_blank", rel: "noopener",
    html: `${icon(iconName, 16)}<span>${label}</span>`,
  });

  about.append(
    avatar,
    el("p", { class: "xsmall muted" }, "A project by"),
    el("a", { class: "set-author", href: AUTHOR_URL, target: "_blank", rel: "noopener" }, "Zubair bin Shaukat"),
    el("div", { class: "row" }, link("GitHub", REPO_URL, "github"), link("About Batwa", "about.html", "info")),
    el("p", { class: "xsmall muted", style: "margin-top:4px" },
      `Batwa v${APP_VERSION} · your money never leaves your device unencrypted`),
  );
  return about;
}

/**
 * The three "where does my data actually go" paragraphs, in one place instead
 * of strung down the settings screen as grey walls of text.
 */
function privacySheet(pinOn) {
  openSheet("How Batwa protects your data", (body) => {
    const block = (title, text) => el("div", { style: "margin-bottom:14px" },
      el("div", { class: "strong small", style: "margin-bottom:4px" }, title),
      el("p", { class: "xsmall muted" }, text));
    body.append(
      block("Cloud sync", pinOn
        ? "Only the encrypted blob is uploaded — another device needs this PIN to restore it. Your JSONBin keys live in this app's storage, so don't share your deployed URL publicly if the bin is private."
        : "Only the encrypted blob is uploaded, with its key inside — any device with your Bin ID and master key can restore it, so treat those credentials like a password (or set up a PIN for stronger protection)."),
      block("Bill reminders",
        "Reminders run in the background even when Batwa is closed. To do that, only the due dates and how many bills fall on each are kept outside the encrypted ledger — never titles or amounts. Android decides how often it runs (usually once or twice a day) and only for apps you actually use."),
      block("Shared spaces",
        "A space is a random id, a write token and a key that live inside your encrypted ledger. The relay stores ciphertext only."),
      el("div", { class: "form-actions" },
        el("button", { class: "btn btn-primary", onclick: () => closeSheet() }, "Got it"),
      ),
    );
  });
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

    // The same inline editor the expense/income forms use — never a nested
    // sheet. It lives at the top of the list and is aimed at whichever row
    // (or "New category") opened it.
    const panel = categoryEditorPanel({
      getTarget: () => RESERVED_CATEGORY,
      onSaved: () => paint(),
    });

    const newBtn = el("button", {
      class: "btn btn-primary btn-block", type: "button",
      onclick: () => { buzz(8); panel.open("new"); },
    }, "New category");

    /** Inline confirm, in place of the row — no second sheet, no window.confirm. */
    function askDelete(c, rowEl) {
      const n = countInCategory(c);
      rowEl.classList.add("is-confirming");
      rowEl.replaceChildren(
        el("span", { class: "small cat-confirm-txt" },
          n ? `Delete ${c}? ${n} ${n === 1 ? "entry moves" : "entries move"} to ${RESERVED_CATEGORY}` : `Delete ${c}?`),
        el("button", {
          class: "btn btn-ghost btn-sm", type: "button",
          onclick: () => { buzz(6); paint(); },
        }, "Cancel"),
        el("button", {
          class: "btn btn-danger btn-sm", type: "button",
          onclick: async () => {
            buzz(14);
            const moved = await deleteCategory(c);
            paint();
            toast(moved ? `${c} deleted · ${moved} moved to ${RESERVED_CATEGORY}` : `${c} deleted`,
              { icon: icon("trash", 17) });
          },
        }, "Delete"),
      );
    }

    const paint = () => {
      wrap.replaceChildren();
      for (const c of state.categories) {
        const limitInput = el("input", {
          class: "input input-sm", type: "text", inputmode: "numeric",
          autocomplete: "off", placeholder: "No limit",
          "aria-label": `Monthly limit for ${c}`,
          value: state.limits[c] ? String(state.limits[c]) : "",
        });
        // digits only; empty clears the limit. Saved on change, never per keystroke.
        limitInput.addEventListener("change", async () => {
          const clean = limitInput.value.replace(/[^0-9]/g, "");
          limitInput.value = clean;
          const map = { ...state.limits };
          if (clean && Number(clean) > 0) map[c] = Number(clean);
          else delete map[c];
          await saveLimits(map);
        });

        // Name + icon open the editor on this category.
        const nameBtn = el("button", {
          type: "button", class: "cat-row-name",
          "aria-label": `Edit ${c}`,
          onclick: () => { buzz(6); panel.open("edit", c); },
        },
          el("span", { class: "cat-limit-ico", html: catIcon(c, 15) }),
          el("span", { class: "small strong truncate" }, c));

        const rowEl = el("div", { class: "cat-limit-row" },
          nameBtn,
          el("span", { class: "cat-limit-field" }, el("span", { class: "cat-limit-cur" }, "Rs"), limitInput),
        );
        if (c !== RESERVED_CATEGORY) {
          rowEl.append(el("button", {
            class: "cat-x", "aria-label": `Remove ${c}`,
            onclick: () => { buzz(8); askDelete(c, rowEl); },
            html: icon("x", 13),
          }));
        } else {
          rowEl.append(el("span", { class: "cat-x-spacer" }));
        }
        wrap.append(rowEl);
      }
    };
    paint();

    body.append(
      el("p", { class: "small muted", style: "margin-bottom:12px" },
        "Tap a category to rename it, change its icon or set a monthly limit. Limits show up in Reports and on Home. “Others” always stays — it's the fallback for anything deleted."),
      wrap,
      el("div", { style: "margin-top:16px" }, newBtn),
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
