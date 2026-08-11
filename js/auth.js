// PIN setup / verify / change + full-screen lock with custom keypad,
// plus the optional no-PIN "device key" mode and first-run onboarding.
// The PIN is never stored — only a salt and an AES-GCM verification token.

import { openDB, getMeta, setMeta, dbGet } from "./db.js";
import { deriveKey, encrypt, decrypt, randomSalt, b64, unb64 } from "./crypto.js";
import { $, el, esc, anim, animTo, motionOK, buzz } from "./util/dom.js";
import { icon } from "./ui/icons.js";

const VERIFY_TOKEN = "batwa-ok";
const LOCK_TIMEOUT_MS = 60000; // relock after 60s in background

let _key = null;         // in-memory AES key while unlocked
let _mode = "none";      // "pin" | "device" | "none" — synchronous view of the key mode
export const getKey = () => _key;
export const isUnlocked = () => !!_key;
/** Which key protects the ledger right now. Settings reads this synchronously. */
export const getKeyMode = () => _mode;

export async function hasPin() {
  return !!(await getMeta("pinSalt"));
}

/** No-PIN mode: a random 256-bit key lives in the meta store instead of a PIN. */
export async function hasDeviceKey() {
  return !!(await getMeta("deviceKey"));
}

/** True first run: no PIN, no device key, and no ledger blob to lose. */
export async function isFirstRun() {
  if (await getMeta("pinSalt")) return false;
  if (await getMeta("deviceKey")) return false;
  return !(await dbGet("entries", "blob"));
}

async function persistNewPin(pin) {
  const salt = randomSalt();
  const key = await deriveKey(pin, salt);
  const verifier = await encrypt(key, VERIFY_TOKEN);
  await setMeta("pinSalt", salt);
  await setMeta("pinVerifier", verifier);
  await setMeta("pinAttempts", 0);
  await setMeta("pinLockUntil", 0);
  _mode = "pin";
  return key;
}

/* ============================================================
   Device key (no-PIN mode)
   ============================================================ */

const importRawKey = (rawB64) =>
  crypto.subtle.importKey("raw", unb64(rawB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

const freshDeviceKeyB64 = () => b64(crypto.getRandomValues(new Uint8Array(32)));

/** Create + store a device key and unlock with it. Used by onboarding. */
export async function createDeviceKey() {
  const raw = freshDeviceKeyB64();
  const key = await importRawKey(raw);
  await setMeta("deviceKey", raw);
  _key = key;
  _mode = "device";
  return key;
}

/** Boot path for no-PIN users: no keypad, no prompt. */
export async function unlockWithDeviceKey() {
  const raw = await getMeta("deviceKey");
  if (!raw) return null;
  _key = await importRawKey(raw);
  _mode = "device";
  return _key;
}

/**
 * Atomic key swap. The re-encrypted blob and the meta flags that say which key
 * opens it commit in ONE IndexedDB transaction, so a crash can never leave the
 * ledger encrypted under a key the app no longer knows about.
 */
async function commitKeySwap({ cipher = null, set = {}, del = [] }) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(["entries", "meta"], "readwrite");
    if (cipher) t.objectStore("entries").put(cipher, "blob");
    const meta = t.objectStore("meta");
    for (const [k, v] of Object.entries(set)) meta.put(v, k);
    for (const k of del) meta.delete(k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function tryPin(pin) {
  const salt = await getMeta("pinSalt");
  const verifier = await getMeta("pinVerifier");
  try {
    const key = await deriveKey(pin, salt);
    const token = await decrypt(key, verifier);
    if (token === VERIFY_TOKEN) { _mode = "pin"; return key; }
  } catch { /* wrong PIN -> GCM auth failure */ }
  return null;
}

/** Escalating delay after 10 wrong attempts. Never wipes data. */
async function registerFailure() {
  const n = ((await getMeta("pinAttempts")) || 0) + 1;
  await setMeta("pinAttempts", n);
  if (n >= 10) {
    const delay = Math.min(30000 * 2 ** (n - 10), 1800000);
    await setMeta("pinLockUntil", Date.now() + delay);
    return { attempts: n, waitMs: delay };
  }
  return { attempts: n, waitMs: 0 };
}

/** Seconds left on the lockout, or 0. */
async function cooldownLeft() {
  const until = (await getMeta("pinLockUntil")) || 0;
  return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
}

/** Re-encrypt the whole blob from one key to another. Returns the cipher or null. */
async function reencrypt(fromKey, toKey) {
  const blob = await dbGet("entries", "blob");
  if (!blob) return null;
  return encrypt(toKey, await decrypt(fromKey, blob));
}

/** Change PIN: verify old, re-encrypt the entries blob under the new key. */
export async function changePin(oldPin, newPin) {
  const oldKey = await tryPin(oldPin);
  if (!oldKey) return { ok: false, reason: "Current PIN is incorrect" };
  const salt = randomSalt();
  const newKey = await deriveKey(newPin, salt);
  const verifier = await encrypt(newKey, VERIFY_TOKEN);
  let cipher;
  try {
    cipher = await reencrypt(oldKey, newKey);
  } catch {
    return { ok: false, reason: "Couldn't re-encrypt your data — nothing was changed" };
  }
  await commitKeySwap({
    cipher,
    set: { pinSalt: salt, pinVerifier: verifier, pinAttempts: 0, pinLockUntil: 0 },
  });
  _key = newKey;
  _mode = "pin";
  return { ok: true };
}

/**
 * Turn the PIN off: verify it, then hand the ledger over to a fresh device key.
 * The blob + the new key + the removal of the PIN meta all land in one commit.
 */
export async function disablePin(currentPin) {
  const wait = await cooldownLeft();
  if (wait) return { ok: false, reason: `Too many attempts — wait ${wait}s` };
  const oldKey = await tryPin(currentPin);
  if (!oldKey) {
    const { attempts, waitMs } = await registerFailure();
    return {
      ok: false,
      reason: waitMs
        ? `Wrong PIN — locked for ${Math.round(waitMs / 1000)}s`
        : `Current PIN is incorrect${attempts >= 5 ? ` (${attempts} attempts)` : ""}`,
    };
  }
  const raw = freshDeviceKeyB64();
  const newKey = await importRawKey(raw);
  let cipher;
  try {
    cipher = await reencrypt(oldKey, newKey);
  } catch {
    return { ok: false, reason: "Couldn't re-encrypt your data — your PIN is unchanged" };
  }
  await commitKeySwap({
    cipher,
    set: { deviceKey: raw },
    del: ["pinSalt", "pinVerifier", "pinAttempts", "pinLockUntil"],
  });
  _key = newKey;
  _mode = "device";
  return { ok: true };
}

/** Turn a PIN on from no-PIN mode: re-encrypt from the device key, then drop it. */
export async function enablePin(newPin) {
  if (!/^\d{4}$/.test(String(newPin))) return { ok: false, reason: "PIN must be 4 digits" };
  const oldKey = _key || (await unlockWithDeviceKey());
  if (!oldKey) return { ok: false, reason: "Batwa is locked — reopen the app and try again" };
  const salt = randomSalt();
  const newKey = await deriveKey(newPin, salt);
  const verifier = await encrypt(newKey, VERIFY_TOKEN);
  let cipher;
  try {
    cipher = await reencrypt(oldKey, newKey);
  } catch {
    return { ok: false, reason: "Couldn't re-encrypt your data — nothing was changed" };
  }
  await commitKeySwap({
    cipher,
    set: { pinSalt: salt, pinVerifier: verifier, pinAttempts: 0, pinLockUntil: 0 },
    del: ["deviceKey"],
  });
  _key = newKey;
  _mode = "pin";
  return { ok: true };
}

export function lock() {
  _key = null;
}

/** Relock automatically when backgrounded past the timeout. No-PIN mode never locks. */
export function initAutoLock(onLock) {
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && _key && Date.now() - hiddenAt > LOCK_TIMEOUT_MS) {
      // there is nothing to ask for without a PIN — relocking would just be a dead end
      if (!(await hasPin())) return;
      lock();
      onLock();
    }
  });
}

/* ============================================================
   Lock screen UI
   mode: "unlock" | "setup"
   ============================================================ */

const KEYS = ["1","2","3","4","5","6","7","8","9","","0","del"];

function keypadSVG() {
  return `<svg width="40" height="40" viewBox="0 0 48 48" fill="none">
    <rect x="10" y="20" width="28" height="22" rx="7" fill="#fff" opacity="0.9"/>
    <path d="M16 20v-4a8 8 0 0 1 16 0v4" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
    <circle cx="24" cy="30" r="3.4" fill="#5B3DF0"/>
    <rect x="22.4" y="31" width="3.2" height="6" rx="1.6" fill="#5B3DF0"/>
  </svg>`;
}

function renderLockScreen({ title, sub, back = null }) {
  const root = $("#lock-root");
  root.innerHTML = "";
  const screen = el("div", { class: "lock-screen", role: "dialog", "aria-modal": "true", "aria-label": title });
  screen.innerHTML = `
    <div class="lock-logo">${keypadSVG()}</div>
    <div style="text-align:center">
      <div class="lock-title">${title}</div>
      <div class="lock-sub">${sub}</div>
    </div>
    <div class="pin-dots" aria-hidden="true">
      ${'<span class="pin-dot"></span>'.repeat(4)}
    </div>
    <div class="lock-msg" role="alert"></div>
    <div class="keypad"></div>
  `;
  const pad = $(".keypad", screen);
  for (const k of KEYS) {
    if (k === "") { pad.append(el("span", { class: "key key-ghost", "aria-hidden": "true" })); continue; }
    const btn = el("button", { class: "key" + (k === "del" ? " key-ghost" : ""), "data-key": k, "aria-label": k === "del" ? "Delete" : k });
    btn.innerHTML = k === "del"
      ? '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-6 8 6 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="m18 9-6 6M12 9l6 6"/></svg>'
      : k;
    pad.append(btn);
  }
  if (back) {
    screen.prepend(el("button", {
      class: "lock-back", "aria-label": "Back", onclick: () => { buzz(6); back(); },
      html: icon("chevron-left", 22),
    }));
  }
  root.append(screen);
  anim(screen, { opacity: 0 }, { opacity: 1, duration: 0.25 });
  anim($(".lock-logo", screen), { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: "back.out(1.8)" });
  anim([$(".lock-title", screen), $(".lock-sub", screen)], { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, stagger: 0.06, delay: 0.1 });
  anim($$keys(screen), { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, stagger: 0.025, delay: 0.15, ease: "power2.out" });
  return screen;
}
const $$keys = (screen) => [...screen.querySelectorAll(".key")];

function wireKeypad(screen, onDigit, onDelete) {
  screen.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-key]");
    if (!btn) return;
    buzz(8);
    btn.dataset.key === "del" ? onDelete() : onDigit(btn.dataset.key);
  });
  screen.addEventListener("keydown", (e) => {
    if (/^[0-9]$/.test(e.key)) onDigit(e.key);
    if (e.key === "Backspace") onDelete();
  });
  screen.tabIndex = -1;
  screen.focus();
}

function paintDots(screen, n) {
  [...screen.querySelectorAll(".pin-dot")].forEach((d, i) => d.classList.toggle("is-filled", i < n));
}

function shake(screen) {
  buzz(60);
  const dots = screen.querySelector(".pin-dots");
  if (motionOK()) {
    gsap.fromTo(dots, { x: 0 }, { x: 10, duration: 0.06, repeat: 5, yoyo: true, clearProps: "x" });
  }
}

function dismiss(screen, done) {
  animTo(screen, {
    opacity: 0, scale: 1.04, duration: 0.3, ease: "power2.in",
    onComplete: () => { screen.remove(); done && done(); }
  });
}

/**
 * First launch: set a 4-digit PIN, entered twice. Resolves with the key.
 * `onBack` (onboarding only) shows a back chevron; the promise then never
 * settles — the caller re-renders its own screen instead.
 */
export function showSetup({ onBack = null } = {}) {
  return new Promise((resolve) => {
    const screen = renderLockScreen({
      title: "Create your PIN",
      sub: "4 digits. It encrypts everything — there is no recovery if you forget it.",
      back: onBack,
    });
    const msg = screen.querySelector(".lock-msg");
    let first = null, buf = "";

    wireKeypad(screen,
      async (d) => {
        if (buf.length >= 4) return;
        buf += d;
        paintDots(screen, buf.length);
        if (buf.length < 4) return;
        if (first === null) {
          first = buf; buf = "";
          setTimeout(() => {
            paintDots(screen, 0);
            screen.querySelector(".lock-title").textContent = "Confirm your PIN";
            msg.textContent = "";
          }, 180);
        } else if (buf === first) {
          const key = await persistNewPin(buf);
          _key = key;
          buzz(20);
          dismiss(screen, () => resolve(key));
        } else {
          first = null; buf = "";
          msg.textContent = "PINs didn't match — start again";
          screen.querySelector(".lock-title").textContent = "Create your PIN";
          shake(screen);
          setTimeout(() => paintDots(screen, 0), 300);
        }
      },
      () => { buf = buf.slice(0, -1); paintDots(screen, buf.length); }
    );
  });
}

/** Every open / resume: verify PIN. Resolves with the key. */
export function showLock() {
  return new Promise((resolve) => {
    const screen = renderLockScreen({
      title: "Welcome back",
      sub: "Enter your PIN to unlock your money.",
    });
    const msg = screen.querySelector(".lock-msg");
    let buf = "", busy = false;

    async function refreshCooldown() {
      const until = (await getMeta("pinLockUntil")) || 0;
      if (until > Date.now()) {
        const s = Math.ceil((until - Date.now()) / 1000);
        msg.textContent = `Too many attempts — wait ${s}s`;
        return true;
      }
      return false;
    }
    refreshCooldown();

    wireKeypad(screen,
      async (d) => {
        if (busy || buf.length >= 4) return;
        if (await refreshCooldown()) { shake(screen); return; }
        buf += d;
        paintDots(screen, buf.length);
        if (buf.length < 4) return;
        busy = true;
        const key = await tryPin(buf);
        if (key) {
          _key = key;
          await setMeta("pinAttempts", 0);
          await setMeta("pinLockUntil", 0);
          buzz(20);
          dismiss(screen, () => resolve(key));
        } else {
          const { attempts, waitMs } = await registerFailure();
          buf = "";
          shake(screen);
          msg.textContent = waitMs
            ? `Wrong PIN — locked for ${Math.round(waitMs / 1000)}s`
            : `Wrong PIN${attempts >= 5 ? ` (${attempts} attempts)` : ""}`;
          setTimeout(() => { paintDots(screen, 0); busy = false; }, 350);
        }
      },
      () => { if (!busy) { buf = buf.slice(0, -1); paintDots(screen, buf.length); } }
    );
  });
}

/* ============================================================
   First-run onboarding
   Welcome -> security choice -> (app boots) -> accounts.
   Same full-screen-overlay approach as the lock screen.
   ============================================================ */

/** Mark onboarding finished. Gating still relies on key existence — see isFirstRun(). */
const markOnboarded = () => setMeta("onboardedAt", new Date().toISOString());

/** Reuses the lock screen's gradient canvas; no cross-fade between steps. */
function onbScreen(label) {
  const root = $("#lock-root");
  const continuing = !!root.querySelector(".onb-screen");
  root.innerHTML = "";
  const screen = el("div", {
    class: "lock-screen onb-screen", role: "dialog", "aria-modal": "true", "aria-label": label,
  });
  root.append(screen);
  if (!continuing) anim(screen, { opacity: 0 }, { opacity: 1, duration: 0.3 });
  return screen;
}

function onbCard(screen, html) {
  const card = el("div", { class: "onb-card" });
  card.innerHTML = html;
  screen.append(card);
  anim([...card.children], { y: 18, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.42, stagger: 0.07, ease: "power2.out" });
  return card;
}

/**
 * Steps 1–2. Resolves with the key once the user has picked PIN or no-PIN.
 * Nothing is written to disk until that choice is made.
 */
export function showOnboarding() {
  return new Promise((resolve) => {
    welcome();

    function welcome() {
      const screen = onbScreen("Welcome to Batwa");
      const card = onbCard(screen, `
        <div class="onb-logo"><img src="branding/logo.svg" alt="" width="46" height="46"></div>
        <div class="onb-brand">Batwa</div>
        <p class="onb-lead">Every rupee in, every rupee out — and exactly what's left to spend.</p>
        <ul class="onb-points">
          <li><span class="onb-tick">${icon("check", 13)}</span> Works fully offline, installs like an app</li>
          <li><span class="onb-tick">${icon("check", 13)}</span> Encrypted on this phone — no account, no cloud</li>
          <li><span class="onb-tick">${icon("check", 13)}</span> Bills, salaries and balances in one screen</li>
        </ul>
      `);
      card.append(el("div", { class: "onb-actions" },
        el("button", { class: "onb-btn", onclick: () => { buzz(8); choice(); } }, "Get started")));
      anim([...card.querySelectorAll(".onb-actions")], { y: 14, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.4, delay: 0.28, ease: "power2.out" });
      focusFirst(card);
    }

    function choice() {
      const screen = onbScreen("Choose how Batwa opens");
      const card = onbCard(screen, `
        <div class="onb-logo onb-logo-sm">${icon("lock", 26)}</div>
        <div class="onb-title">How should Batwa open?</div>
        <p class="onb-lead onb-lead-sm">Your data is encrypted either way. This decides who can read it.</p>
      `);
      const pick = el("div", { class: "onb-opts" });

      const withPin = el("button", { class: "onb-opt", onclick: () => { buzz(8); toPinSetup(); } });
      withPin.innerHTML = `
        <span class="onb-opt-ico">${icon("lock", 20)}</span>
        <span class="onb-opt-txt">
          <span class="onb-opt-title">Protect with a PIN <em class="onb-badge">Recommended</em></span>
          <span class="onb-opt-sub">4 digits, asked every time you open Batwa. The PIN <strong>is</strong> the encryption key.</span>
        </span>
        <span class="onb-opt-chev">${icon("chevron-right", 18)}</span>`;

      const noPin = el("button", { class: "onb-opt", onclick: () => { buzz(8); toNoPin(noPin); } });
      noPin.innerHTML = `
        <span class="onb-opt-ico">${icon("zap", 20)}</span>
        <span class="onb-opt-txt">
          <span class="onb-opt-title">Continue without a PIN</span>
          <span class="onb-opt-sub">Opens straight to your money. Anyone who can unlock this phone can see it.</span>
        </span>
        <span class="onb-opt-chev">${icon("chevron-right", 18)}</span>`;

      pick.append(withPin, noPin);
      card.append(pick, el("p", { class: "onb-foot" }, "You can add or remove the PIN later in Settings."));
      anim([pick, card.querySelector(".onb-foot")], { y: 16, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.4, stagger: 0.08, delay: 0.2, ease: "power2.out" });

      screen.prepend(el("button", {
        class: "lock-back", "aria-label": "Back", onclick: () => { buzz(6); welcome(); },
        html: icon("chevron-left", 22),
      }));
      focusFirst(pick);
    }

    async function toPinSetup() {
      const key = await showSetup({ onBack: () => choice() });
      await markOnboarded();
      resolve(key);
    }

    async function toNoPin(btn) {
      btn.disabled = true;
      const key = await createDeviceKey();
      await markOnboarded();
      buzz(20);
      dismiss($(".onb-screen"), () => resolve(key));
    }
  });
}

function focusFirst(root) {
  const b = root.querySelector("button");
  if (b && !("ontouchstart" in window)) setTimeout(() => b.focus(), 120);
}

/**
 * Step 3, shown after the ledger is loaded so accounts can actually be saved.
 * Resolves when the user is done — always, even if they add nothing.
 */
export function showAccountsStep() {
  return new Promise((resolve) => {
    const screen = onbScreen("Add your accounts");
    const card = onbCard(screen, `
      <div class="onb-logo onb-logo-sm">${icon("wallet", 26)}</div>
      <div class="onb-title">Where does your money sit?</div>
      <p class="onb-lead onb-lead-sm">Add JazzCash, a bank, or plain cash — Batwa keeps a balance for each one.</p>
    `);
    const list = el("div", { class: "onb-list" });
    const addBtn = el("button", { class: "onb-btn" }, "＋ Add account");
    const doneBtn = el("button", { class: "onb-btn onb-btn-ghost" }, "Skip for now");
    card.append(list, el("div", { class: "onb-actions" }, addBtn, doneBtn));
    anim([addBtn, doneBtn], { y: 14, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.4, stagger: 0.06, delay: 0.22, ease: "power2.out" });

    // home is already painted underneath — don't let it scroll behind the overlay
    document.body.classList.add("is-onboarding");

    let alive = true;
    const finish = async () => {
      if (!alive) return;
      alive = false;
      document.body.classList.remove("is-onboarding");
      await markOnboarded();
      dismiss(screen, resolve);
    };
    doneBtn.addEventListener("click", () => { buzz(8); finish(); });

    // ledger + accounts are pulled in lazily: auth.js must not import them
    // statically (ledger.js imports getKey from here).
    (async () => {
      const [accounts, ledger] = await Promise.all([
        import("./ui/accounts.js"),
        import("./ledger.js"),
      ]);
      const paint = () => {
        if (!alive) return;
        list.innerHTML = "";
        for (const acc of ledger.state.accounts) {
          const row = el("div", { class: "onb-acc" });
          row.innerHTML = `${accounts.logoTile(acc.kind, 30)}<span class="truncate">${esc(acc.name)}</span>
            <span class="onb-acc-tick">${icon("check", 15)}</span>`;
          list.append(row);
          anim(row, { x: -10, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3, ease: "power2.out" });
        }
        // once there's an account, "Done" becomes the primary action
        const n = ledger.state.accounts.length;
        doneBtn.textContent = n ? "Done" : "Skip for now";
        doneBtn.classList.toggle("onb-btn-ghost", !n);
        addBtn.classList.toggle("onb-btn-ghost", !!n);
        addBtn.textContent = n ? "＋ Add another" : "＋ Add account";
      };
      ledger.onChange(paint);
      paint();
      addBtn.addEventListener("click", () => { buzz(8); accounts.addAccountSheet(); });
    })();
  });
}
