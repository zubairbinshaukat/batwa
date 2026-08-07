// PIN setup / verify / change + full-screen lock with custom keypad.
// The PIN is never stored — only a salt and an AES-GCM verification token.

import { getMeta, setMeta, dbGet, dbPut } from "./db.js";
import { deriveKey, encrypt, decrypt, randomSalt } from "./crypto.js";
import { $, el, anim, animTo, motionOK, buzz } from "./util/dom.js";

const VERIFY_TOKEN = "batwa-ok";
const LOCK_TIMEOUT_MS = 60000; // relock after 60s in background

let _key = null;         // in-memory AES key while unlocked
export const getKey = () => _key;
export const isUnlocked = () => !!_key;

export async function hasPin() {
  return !!(await getMeta("pinSalt"));
}

async function persistNewPin(pin) {
  const salt = randomSalt();
  const key = await deriveKey(pin, salt);
  const verifier = await encrypt(key, VERIFY_TOKEN);
  await setMeta("pinSalt", salt);
  await setMeta("pinVerifier", verifier);
  await setMeta("pinAttempts", 0);
  await setMeta("pinLockUntil", 0);
  return key;
}

async function tryPin(pin) {
  const salt = await getMeta("pinSalt");
  const verifier = await getMeta("pinVerifier");
  try {
    const key = await deriveKey(pin, salt);
    const token = await decrypt(key, verifier);
    if (token === VERIFY_TOKEN) return key;
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

/** Change PIN: verify old, re-encrypt the entries blob under the new key. */
export async function changePin(oldPin, newPin) {
  const oldKey = await tryPin(oldPin);
  if (!oldKey) return { ok: false, reason: "Current PIN is incorrect" };
  const blob = await dbGet("entries", "blob");
  let data = null;
  if (blob) data = await decrypt(oldKey, blob);
  _key = await persistNewPin(newPin);
  if (data !== null) await dbPut("entries", "blob", await encrypt(_key, data));
  return { ok: true };
}

export function lock() {
  _key = null;
}

/** Relock automatically when backgrounded past the timeout. */
export function initAutoLock(onLock) {
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && _key && Date.now() - hiddenAt > LOCK_TIMEOUT_MS) {
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

function renderLockScreen({ title, sub }) {
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

/** First launch: set a 4-digit PIN, entered twice. Resolves with the key. */
export function showSetup() {
  return new Promise((resolve) => {
    const screen = renderLockScreen({
      title: "Create your PIN",
      sub: "4 digits. It encrypts everything — there is no recovery if you forget it.",
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
