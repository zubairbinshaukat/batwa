# Fingerprint (biometric) unlock + refresh-safe sessions

Status: approved plan, ready to implement. Branch: `develop`. Do not commit; leave changes in the working tree for review.

## 0. Context (what exists today)

- Plain ES-module PWA, no build step, no npm, no tests. Vanilla DOM via `el()` from `js/util/dom.js`, GSAP via `anim()`/`animTo()`, icons via `icon(name, size)` from `js/ui/icons.js`.
- **Encryption model** (`js/crypto.js`, `js/auth.js`): PIN -> PBKDF2 (150k, SHA-256, random `pinSalt`) -> AES-GCM-256 key, created **non-extractable**. `pinVerifier` = AES-GCM of the string `"batwa-ok"`. The ledger is ONE blob at `entries/blob`. Meta is key/value in the `meta` store (`getMeta/setMeta` in `js/db.js`). Wrong PIN = GCM failure.
- **Key modes**: `"pin"` (salt + verifier) or `"device"` (random key stored in meta as `deviceKey`, no lock screen ever). `getKeyMode()` is a synchronous view used by Settings.
- **Atomic re-keying**: `commitKeySwap({ cipher, set, del })` writes the re-encrypted blob and meta changes in one IDB transaction. `changePin`, `disablePin`, `enablePin` all go through it.
- **Lock UI** (`js/auth.js`): `renderLockScreen({title, sub, back})` builds `.lock-screen` (logo, title, sub, 4 `.pin-dot`s, `.lock-msg`, 3x4 `.keypad` where cell index 9 is an empty `.key-ghost` and index 11 is delete). `wireKeypad`, `paintDots`, `shake`, `dismiss`. `showSetup()` (create PIN twice) and `showLock()` (verify, attempts/cooldown via `pinAttempts` / `pinLockUntil`). Both resolve with the key and set the module-level `_key`.
- **Onboarding** (`js/auth.js`): `showOnboarding()` = welcome -> choice (PIN / no PIN) -> `showSetup({onBack})`; `onbScreen(label)` + `onbCard(screen, html)` build the card UI (`css/onboarding.css`: `.onb-card`, `.onb-logo-sm`, `.onb-title`, `.onb-lead-sm`, `.onb-opts/.onb-opt`, `.onb-btn`, `.onb-btn-ghost`, `.onb-foot`, `.onb-badge`). Then `showAccountsStep()` over home.
- **Boot** (`js/app.js` `unlockFlow()`): `hasPin() -> showLock()`, else device key, else first-run, else legacy `showSetup()`. Then `loadLedger()`, render, `initAutoLock(() => unlockFlow())`. `initAutoLock` relocks after 60 s hidden (`LOCK_TIMEOUT_MS`), PIN mode only.
- **Settings** (`js/ui/settings.js`): Security group renders `row("pin", …)` rows from the `ICONS` map; sheets via `openSheet(title, build)`, `confirmSheet`, `chooseSheet` from `js/ui/modals.js`; `toast(text, {icon})`. `refresh()` re-paints settings after a key-mode change. `.set-row`, `.set-ico`, `.set-val`, `.warn-card`, `.field`, `.input`, `.form-actions`, `.btn btn-primary|btn-ghost|btn-soft-danger` exist.
- **Sync/backup** (`js/sync.js`) reads `pinSalt`/`deviceKey` only. Biometrics must not change the blob format or the backup format at all (the biometric key wraps the same PIN key; the blob stays encrypted under the PIN key).
- Service worker precache list + `CACHE = "batwa-v16"` in `sw.js`. Handwriting tips font: `--font-hand` (Caveat).
- The problem to fix in passing: every page **refresh** re-shows the PIN screen because `_key` only lives in module memory.

### Research summary (Sept 2026, see sources at the end)

- WebAuthn `prf` is Chrome's supported way to get hardware/credential-bound key material; on Android, Google Password Manager passkeys support PRF by default, with `authenticatorAttachment:"platform"` + `residentKey:"required"`. PRF output must go through HKDF into a non-extractable AES key, never be used directly.
- At `create()` Android usually returns only `prf.enabled:true` (no `results`) -> a follow-up `get()` is needed for the first PRF output. Chrome 147+ reportedly returns results at create; feature-detect at runtime.
- `getClientCapabilities()` reports `extension:prf`, `userVerifyingPlatformAuthenticator`, etc. (client support only). WebAuthn needs a secure context (`https` or `http://localhost`; **not** `127.0.0.1`).
- Cancel, timeout, missing gesture and "credential deleted" all surface as `NotAllowedError` with no distinguishing field. Chrome requires user activation for `create()` and, in practice, `get()`.
- Passkeys sync to Google Password Manager; cannot be opted out. Re-enrolling a fingerprint on Android does **not** invalidate a passkey.
- `largeBlob` is unavailable on Android. `sessionStorage` survives reload but Chrome's tab restore can also bring it back after a process kill, so a stored session needs an absolute expiry as well.

## 1. Deliverable, as the user will see it

### 1.1 Lock screen, fingerprint enrolled (JazzCash-style, biometric first)

```
+------------------------------------------+
|                                          |
|              (  [fingerprint]  )         |   big 96px round button, pulsing ring
|                                          |
|             Welcome back                 |
|      Touch the fingerprint sensor        |
|                                          |
|            [ Use PIN instead ]           |   ghost pill button
|                                          |
+------------------------------------------+
```

- One best-effort attempt to launch the native Android sheet **automatically** on mount (Chrome may refuse without a user gesture, in which case the screen just sits in its idle state with no error). Tapping the big fingerprint button is the guaranteed path and launches the sheet.
- Cancel / back / timeout / "no matching credential" on the native sheet -> the screen **morphs to the keypad** (same `.lock-screen`, no re-mount): fingerprint button slides out, dots + keypad slide in; the empty keypad cell (index 9) becomes a **fingerprint key** so the user can go back to biometrics with one tap.
- 3 consecutive biometric failures (`bioFails >= 3`) -> auto-prompt stops, the keypad is shown first with the hint "Use your PIN this time", fingerprint key still visible. A successful PIN or biometric unlock resets `bioFails`.
- Successful biometric -> same dismiss animation as a PIN unlock.

### 1.2 Lock screen, PIN set but no fingerprint (compact offer)

Below the keypad, a compact glass chip (only when the device supports it and the user hasn't dismissed it):

```
+------------------------------------------------------+
| [fp]  Unlock faster with your fingerprint            |
|       Set up after you enter your PIN    [Set up] x  |
+------------------------------------------------------+
```

- "Set up" toggles the chip to "Will set up right after your PIN ✓" (intent only; nothing is stored yet). After the PIN is verified, enrolment runs with the PIN just typed, then the screen dismisses. Success -> toast "Fingerprint unlock is on". Failure/cancel -> toast with the reason; the app still unlocks (PIN was correct).
- `x` dismisses and sets meta `bioOfferDismissed = true` + `localStorage["batwa.bioOffer"] = "0"`. Never shown again on the lock screen; Settings still offers it.

### 1.3 Onboarding step (after "Create your PIN" -> "Confirm your PIN")

New `onb` card, only if the device supports biometrics; otherwise the flow is unchanged:

```
   [fingerprint icon tile]
   Add your fingerprint?
   Open Batwa with a touch. Your PIN still works
   and is still the key — the fingerprint just
   unlocks it for you.
   [ Use fingerprint ]        (primary)
   [ Not now ]                (ghost)
   "You can turn this on or off any time in Settings."
```

"Use fingerprint" -> native sheet -> success toast -> continue to the accounts step. Cancel -> stay on the card with an inline message ("Nothing was set up — try again or skip"). "Not now" -> continue.

### 1.4 Settings -> Security

- PIN on, biometrics supported, not enrolled: row `Fingerprint unlock` value `Off` -> **enable sheet**: explanation + current PIN input + "Turn on" (needs PIN, because the PIN key has to be re-derived to wrap it).
- PIN on, enrolled: row `Fingerprint unlock` value `On` -> **manage sheet**: "Turn off" (no PIN required; just deletes the wrapped key) and a note "Removing it never touches your data or PIN. To use it again you'll need your PIN once."
- PIN on, device unsupported: row `Fingerprint unlock` value `Unavailable` (disabled look) with a one-line explanation under the card.
- PIN off (device-key mode): no fingerprint row at all; the existing "Set up a PIN" sheet gets one extra line: "You can add fingerprint unlock after the PIN is on." After `enablePin` succeeds, if supported, `chooseSheet`-style prompt "Add fingerprint unlock now?" -> runs the enable flow with the PIN just entered.
- Existing warn-card text stays; add a sentence when enrolled: "Fingerprint unlock is a convenience on top of the PIN, not a replacement — the PIN is still the only recovery."

### 1.5 Refresh persists, close re-locks

- Page **reload / refresh / SW-update reload**: app opens straight to the last view without asking (PIN mode).
- App **closed** (swiped away / tab closed) and reopened: fingerprint sheet (if enrolled) or PIN.
- Backgrounded > 60 s, then resumed (including "system killed it while hidden, Chrome restored the tab"): lock, exactly as today.
- Device-key mode is unaffected (never locks anyway).

## 2. Architecture

### 2.1 `js/crypto.js` additions (pure, Node-testable)

```js
export async function deriveKeyBits(pin, saltB64)   // PBKDF2 same params -> ArrayBuffer(32)
export async function importAesKey(rawBytes, { extractable = false } = {}) // -> AES-GCM CryptoKey
export async function hkdfAesKey(ikmBytes, infoStr, saltBytes) // HKDF-SHA256 -> AES-GCM-256 non-extractable key
```
- `deriveKey` stays as is (call sites unchanged). Keep `ITERATIONS` shared so `deriveKeyBits` matches `deriveKey` bit-for-bit (`deriveBits` then `importKey("raw", …, "AES-GCM")` yields the identical key).
- Node fixture: `deriveKey(pin,salt)` encrypt -> `importAesKey(await deriveKeyBits(pin,salt))` decrypt round-trips; HKDF is deterministic for the same ikm/info/salt and differs on any change.

### 2.2 New module `js/biometric.js` (WebAuthn PRF layer; no DOM, no auth.js import)

```js
export function bioSupportedSync()            // synchronous: window.PublicKeyCredential && isSecureContext
export async function bioAvailable()          // isSecureContext && isUserVerifyingPlatformAuthenticatorAvailable() && (getClientCapabilities?.()["extension:prf"] !== false); cached per page load. getClientCapabilities reports CLIENT support only — the authenticator's answer is prf.enabled at create().
export async function isBioEnrolled()         // !!(await getMeta("bio"))
export async function enrollBio(pinKeyBits)   // -> { ok:true } | { ok:false, reason, code }
export async function unwrapWithBio()         // -> { ok:true, keyBits } | { ok:false, reason, code:"cancel"|"gone"|"unsupported"|"corrupt" }
export async function removeBio({ signal = true } = {}) // deletes meta.bio, clears localStorage hint, best-effort signalUnknownCredential
export async function rewrapBio(newPinKeyBits) // used by changePin; -> { ok } ; on failure removes enrolment and returns { ok:false, reason }
export function bioHint()                     // localStorage["batwa.bio"] === "1"  (sync, for first paint before IDB)
```

Storage: meta `bio` = `{ v:1, credId (b64url), userId (b64), prfSalt (b64, 32 random bytes), wrapped:{iv,ct}, createdAt, transports:[] }`. Mirror `localStorage["batwa.bio"] = "1"` on enrol, `"0"`/remove on removal (the user asked for a localStorage copy; it is a **hint only** and never trusted for key material). Meta `bioFails` (int). Meta `bioOfferDismissed` (bool) mirrored to `localStorage["batwa.bioOffer"]`.

**Enrol** (`enrollBio(pinKeyBits)`):
1. `navigator.credentials.create({ publicKey: { rp: { name: "Batwa" }, user: { id: random16, name: "batwa", displayName: "Batwa" }, challenge: random32, pubKeyCredParams: [{type:"public-key", alg:-7}, {type:"public-key", alg:-257}], authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" }, hints: ["client-device"], timeout: 60000, attestation: "none", excludeCredentials: (existing meta.bio ? [{type:"public-key", id: credId}] : []), extensions: { prf: { eval: { first: prfSalt } } } } })`. **Do not set `rp.id` / `rpId`** — let it default to the current origin's domain (works on GitHub Pages, Netlify, localhost alike). `requireResidentKey: true` is the legacy flag Android's Play Services FIDO stack still reads. Must be called from a **user tap** (Chrome requires user activation).
2. `ext = cred.getClientExtensionResults()`. If `!ext.prf?.enabled` -> **unsupported**: return `{ ok:false, code:"unsupported", reason:"This device's fingerprint can't protect a key (PRF not supported)" }` and do not store anything. (Best-effort `signalUnknownCredential` so the useless passkey is cleaned up.)
3. If `ext.prf.results?.first` is present, use it (Chrome 147+ reportedly returns PRF results at create time). Otherwise — the common case on Android/Google Password Manager, which returns only `enabled:true` at create — immediately call `.get()` with `allowCredentials:[{type:"public-key", id: cred.rawId, transports:["internal"]}]`, `hints:["client-device"]`, `userVerification:"required"` and the same `prf.eval` to obtain it (second native prompt; the enable/onboarding copy should say "you may be asked twice").
4. `wrapKey = hkdfAesKey(prfOutput, "batwa/bio-wrap/v1", prfSalt)`; `wrapped = encrypt(wrapKey, b64(pinKeyBits))`. Store meta `bio`, set `bioFails = 0`, set localStorage hint.

**Unlock** (`unwrapWithBio()`):
1. Read meta `bio`; if missing -> `{ok:false, code:"gone"}`.
2. `navigator.credentials.get({ publicKey: { challenge: random32, allowCredentials: [{ type:"public-key", id: credId, transports:["internal"] }], userVerification: "required", hints: ["client-device"], timeout: 60000, extensions: { prf: { eval: { first: prfSalt } } } } })`. No `rpId` (defaults to origin). `allowCredentials` with the stored id skips the account chooser and goes straight to the fingerprint sheet.
3. Errors: `NotAllowedError` -> `code:"cancel"` (covers user cancel, timeout, missing user activation, and "credential deleted from device"; WebAuthn deliberately does not let us distinguish — see §2.6). Record `elapsedMs` on the result so the caller can apply the heuristic: `< 300 ms` = the browser refused outright (no gesture / no credential) -> do not count as a user failure. `SecurityError`/`NotSupportedError` -> `"unsupported"`. Anything else -> `"cancel"` with the message logged.
4. Derive `wrapKey` the same way, `decrypt(wrapped)` -> `keyBits`. GCM failure -> `code:"corrupt"` (caller removes enrolment).

Everything in this module takes/returns raw key **bytes**; auth.js turns them into the non-extractable working key and verifies against `pinVerifier` before trusting them.

### 2.3 New module `js/session.js` (refresh persistence; no DOM)

- IDB meta key `session` = `{ id, key: CryptoKey (non-extractable AES-GCM, structured-cloneable), mode:"pin", hiddenAt: 0|ms, savedAt, expiresAt }`. `sessionStorage["batwa.session"] = id`. `expiresAt = savedAt + SESSION_MAX_MS` (24 h) — an absolute ceiling in addition to the 60 s hidden rule, because Chrome's tab restore can bring `sessionStorage` back after a process kill.
- `saveSession(key)`: new random id, write both.
- `restoreSession(timeoutMs)`: returns the CryptoKey only if meta exists, ids match, `now < expiresAt`, and `(!hiddenAt || now - hiddenAt <= timeoutMs)`; in every other case it **deletes** the meta record and returns null.
- `touchHidden()` / `touchVisible()`: set/clear `hiddenAt` (called from `initAutoLock`, plus `pagehide`).
- `clearSession()`: delete meta + sessionStorage. Called from `lock()`, `changePin` (then re-saved with the new key), `disablePin`, `enablePin` (re-save), and when the blob is replaced by import (`replaceAll`) — no, key doesn't change there; skip.
- Why this design: `sessionStorage` survives reload and SW-triggered `location.reload()`, but is discarded when the PWA window/tab is closed; the key object itself never leaves WebCrypto (non-extractable) and is useless without the matching id; `hiddenAt` reproduces the 60 s background lock even when Chrome kills and restores the tab. Two tabs: the newer unlock wins; the older tab will simply see the lock screen on its next reload. Guard every `sessionStorage` access with try/catch (private mode / storage blocked -> behave as "no session").

### 2.4 `js/auth.js` changes

- Imports from `./biometric.js` and `./session.js` and the new crypto helpers.
- `export const BIO_MAX_FAILS = 3;`
- `unlockWithSession()` (new, exported): `key = await restoreSession(LOCK_TIMEOUT_MS)`; if key -> `_key = key; _mode = "pin"; return key`; else null.
- Every place that sets `_key` after a real unlock/setup (`showSetup` success, `showLock` success both PIN and bio, `changePin`, `enablePin`) calls `saveSession(_key)`. `lock()` calls `clearSession()`. `disablePin` clears the session (device mode needs none) **and** `removeBio()` (a device-key ledger has no lock, so an enrolment would be orphaned).
- `initAutoLock`: on hidden -> `touchHidden()`; on visible within timeout -> `touchVisible()`; on visible past timeout -> existing lock path. Add `window.addEventListener("pagehide", touchHidden)`.
- `changePin(oldPin, newPin)`: after `commitKeySwap`, if `isBioEnrolled()`: `bits = await deriveKeyBits(newPin, salt)`; `res = await rewrapBio(bits)`; if `!res.ok` -> return `{ ok:true, bioDropped:true }` so Settings can toast "PIN changed. Fingerprint unlock was turned off — turn it on again in Settings". Zero `bits` after use (`new Uint8Array(bits).fill(0)`).
- `export async function enrollBiometricWithPin(pin)`: verify with `tryPin` (respect cooldown), `bits = deriveKeyBits(pin, salt)`, `enrollBio(bits)`, zero bits. Returns the biometric result. Used by onboarding step, lock-screen offer, Settings enable sheet, and post-`enablePin` prompt.
- `export async function tryBiometricUnlock()`: `r = await unwrapWithBio()`; if `!r.ok` -> on `"corrupt"` call `removeBio()`; increment `bioFails` on `"cancel"`; return `r`. If ok: `key = importAesKey(r.keyBits)`; verify `decrypt(key, pinVerifier) === VERIFY_TOKEN`; if it fails (PIN changed under the enrolment somehow) -> `removeBio()` and return `{ ok:false, code:"corrupt" }`. Else `_key = key; _mode = "pin"; bioFails = 0; pinAttempts = 0; pinLockUntil = 0; saveSession(key)`; return `{ ok:true, key }`.
- `showLock()` becomes variant-aware:
  - Decide `bioFirst = bioHint() && (await isBioEnrolled()) && (await bioAvailable()) && ((await getMeta("bioFails")) || 0) < BIO_MAX_FAILS`.
  - `renderLockScreen` gets an option `variant: "bio" | "pin"` and `bioKey: boolean`. In `"bio"` variant it renders `.lock-bio` (big button + "Use PIN instead") **and** the dots/keypad already in the DOM but with class `is-hidden`, so switching is a class toggle + GSAP, never a re-render. When `bioKey` is true the empty keypad cell (index 9) is a real `<button class="key key-bio" data-key="bio" aria-label="Use fingerprint">` with the fingerprint icon.
  - On mount in `"bio"` variant: attempt ONE auto-launch via `requestAnimationFrame(() => runBio({ auto: true }))`. Research says Chrome generally requires user activation for `get()`, so the auto attempt is best-effort: if it rejects with `elapsedMs < 300`, show the big button in its idle "Tap to unlock" state silently and count nothing. The big button tap is the primary, guaranteed path. `runBio` calls `tryBiometricUnlock()`; success -> dismiss/resolve; `"cancel"` (after a real prompt) -> `switchToPin("Use your PIN, or tap the fingerprint key to try again")`; `"corrupt"`/`"unsupported"`/`"gone"` -> `switchToPin("Fingerprint unlock was turned off — enter your PIN")`. Do **not** toast on cancel (fintech convention: silently reveal the PIN).
  - The `data-key="bio"` keypad key and the big button both call `runBio()`; guard with `busy`.
  - Offer chip (§1.2): rendered when `!enrolled && (await bioAvailable()) && !(await getMeta("bioOfferDismissed"))`. After a correct PIN, if intent is set: `enrollBiometricWithPin(buf)` before `dismiss`; toast the outcome via a dynamic `import("./ui/toast.js")` (auth.js must not statically import UI that imports ledger; toast.js is safe — check it has no auth import — but keep the dynamic import pattern already used in `showAccountsStep` for consistency).
  - Hardware back / Escape while the native sheet is open is handled by the browser (rejects with NotAllowedError) -> keypad.
- `showSetup()` returns the key as before; the onboarding wrapper `toPinSetup()` now: `key = await showSetup(...)`; `if (await bioAvailable()) await bioStep(pin)` — `showSetup` must expose the confirmed PIN to the caller: change its resolve value to `{ key, pin }` **only** via a new option `{ wantPin: true }` so the legacy `unlockFlow` call keeps receiving the key. The onboarding `bioStep(pin)` builds the card in §1.3 with `onbScreen/onbCard`; "Use fingerprint" -> `enrollBiometricWithPin(pin)`; on `ok` -> `markOnboarded()` + resolve; on failure -> inline `.onb-foot`-styled error and keep both buttons; "Not now" -> continue.
- Zero the PIN string references as soon as enrolment is done (`pin = null`), no logging of PINs anywhere.

### 2.5 `js/app.js` changes

- `unlockFlow()`: `if (await hasPin()) { if (!(await unlockWithSession())) await showLock(); }`. Nothing else changes; `initAutoLock` stays.
- SW `controllerchange -> location.reload()` now lands on an unlocked app because the session survives.

### 2.6 Edge cases and the decision for each

| Case | Behaviour |
|---|---|
| Device has no biometrics / not a secure context / desktop browser | No offers, no onboarding step, Settings shows "Unavailable" with reason. `bioAvailable()` false. |
| `prf` not supported by the platform authenticator (`prf.enabled` false) | Enrol aborts with a clear message; nothing stored; passkey signalled as unknown. Settings row shows "Unavailable — this phone can't protect a key with its fingerprint". |
| User cancels native sheet (enrol) | `{code:"cancel"}` -> inline message, state unchanged. |
| User cancels native sheet (unlock) | Keypad, hint text, `bioFails+1`. |
| Fingerprint/passkey deleted in Android settings or Google Password Manager | Looks identical to cancel (NotAllowedError). After `BIO_MAX_FAILS` the PIN is asked first; the Settings manage sheet has "Turn off" + "Set up again". After a **successful PIN unlock** following a bio failure, show a one-time toast "Fingerprint didn't work? You can reset it in Settings". |
| User adds a *new* fingerprint on the phone | Android passkeys are not invalidated by biometric re-enrolment; nothing to do. |
| Passkey synced to another device via Google Password Manager | Cannot be prevented (no opt-out in WebAuthn). Harmless: the wrapped key + PRF salt live only in this device's IndexedDB, and the blob is under the PIN key anyway. Documented in the Settings info line. |
| `largeBlob` extension | Not available on Android (Play Services FIDO lacks it). Not used. |
| Fallback when PRF unsupported | **None.** A "biometric as UI gate + key in IndexedDB" fallback would give the fingerprint no cryptographic role; we refuse to enrol instead and say why. |
| PIN changed | `rewrapBio` under the new key with one native prompt; on cancel -> enrolment removed, toast says so. |
| PIN disabled (device-key mode) | Enrolment removed, session cleared, localStorage hint cleared. |
| PIN enabled from device-key mode | Offer to add fingerprint immediately (has the PIN in hand). |
| Wrapped key decrypts but fails `pinVerifier` (corrupt/out-of-sync) | Remove enrolment, fall to keypad with explanation. |
| Import "Replace everything" | Blob changes, key does not: nothing to do. `importBackup` from a backup with a *different* PIN re-encrypts under the current key today — verify in `sync.js` that the working key stays the same (it does: it decrypts with the backup key and saves with `getKey()`). |
| `IndexedDB` write of `CryptoKey` fails (old browser) | `saveSession` catches and no-ops; refresh simply asks for the PIN as today. |
| `sessionStorage` throws | Treated as no session. |
| Two tabs | Newer unlock wins; older tab re-locks on its next reload. |
| Cooldown (`pinLockUntil`) active | Biometric unlock is **still allowed** (it proves possession + user verification, and resets `pinAttempts` on success). Keypad still shows the cooldown message. |
| User activation required for `create()` | Enrol always runs from a button tap. |
| Auto-launch `get()` refused without gesture | Show the big button; no failure counted. |
| Reduced motion | All new motion goes through `anim/animTo` (already no-op under reduced motion). |
| Screen reader | Big button `aria-label="Unlock with fingerprint"`, `.lock-msg` stays `role="alert"`, offer chip is a `role="group"` with a labelled button and a labelled dismiss. |

### 2.7 UI/CSS (`css/components.css`, Lock screen block; `css/onboarding.css` for the onb step)

- `.lock-bio` column: `.bio-btn` 96px circle, `rgba(255,255,255,0.16)` glass, `backdrop-filter: blur(8px)`, inset highlight like `.lock-logo`; `.bio-ring` absolutely positioned ring animated with GSAP scale/opacity loop (`repeat:-1`, `yoyo`), stopped under reduced motion; `.bio-btn.is-busy` dims to 0.6. "Use PIN instead" reuses `.onb-btn.onb-btn-ghost` sizing but compact (`min-height:44px; padding:0 20px; width:auto`) -> new class `.lock-alt`.
- `.key.key-bio` = same glass as `.key`, icon-only (fingerprint 28px).
- `.lock-offer` chip: `display:grid; grid-template-columns:auto 1fr auto auto; gap:10px; align-items:center; max-width:360px; width:100%; padding:10px 12px; border-radius:var(--r-lg); background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.18); backdrop-filter:blur(8px);` title `font-weight:800; font-size:var(--fs-sm)`, sub `font-size:var(--fs-xs); color:rgba(255,255,255,0.72)`, `.lock-offer-btn` white pill (`background:#fff; color:var(--c-violet-deep); font-weight:800; padding:8px 12px; border-radius:var(--r-pill)`), `.lock-offer-x` 32px ghost round. `.lock-offer.is-armed` swaps the button for a tick. The chip sits **below** `.keypad`; on `max-height: 640px` drop its sub line.
- `.is-hidden { display:none }` is not enough for the morph: use `.lock-pin-wrap` (dots + msg + keypad + offer) and `.lock-bio` both present, toggle `hidden` attribute after the GSAP fade completes.
- New icon in `js/ui/icons.js`: `fingerprint` (stroke-only, 24-grid, e.g. the Lucide fingerprint path set).
- Onboarding step reuses `.onb-logo-sm`, `.onb-title`, `.onb-lead-sm`, `.onb-actions`, `.onb-btn`, `.onb-btn-ghost`, `.onb-foot`; inline error uses `.lock-msg` colour (`#FFD48A`).
- Settings info lines are `.xsmall muted` paragraphs like the existing ones; the one tip sentence about "fingerprint is a convenience, PIN is the key" may use `--font-hand` inside the warn-card only if it reads well at 15px — otherwise plain.

### 2.8 Service worker + docs

- Add `./js/biometric.js` and `./js/session.js` to `SHELL`; bump `CACHE` to `"batwa-v17"`.
- `batwa-app-spec.md` §4 "PIN lock + encryption": add two bullets (fingerprint = WebAuthn PRF-wrapped copy of the PIN key, removable without PIN, re-adding needs PIN; sessions survive reload via a non-extractable key in IDB keyed by a sessionStorage id, cleared on close/60 s background).
- README: one line under the privacy note.

## 3. Implementation order

1. `js/crypto.js` helpers + Node fixture (`deriveKeyBits` == `deriveKey`; HKDF determinism).
2. `js/session.js`; wire `unlockWithSession` into `app.js` and `saveSession/clearSession/touch*` into `auth.js`. Verify: unlock, reload -> no lock; close tab, reopen -> lock; `hiddenAt` older than 60 s -> lock.
3. `js/biometric.js` + `icons.js` fingerprint + `auth.js` `enrollBiometricWithPin` / `tryBiometricUnlock` / `changePin` re-wrap / `disablePin` cleanup.
4. Lock screen variants + offer chip + CSS.
5. Onboarding step.
6. Settings rows + sheets + post-`enablePin` prompt.
7. `sw.js`, spec, README.
8. `node --check` every changed `.js`. Headless smoke (see §4).

## 4. Verification (required before reporting done)

- `node --check` on every changed/new `.js` file.
- Node fixture for `crypto.js` helpers (pure WebCrypto, runs under Node 24) — put it in the scratchpad, not the repo.
- Headless browser smoke with Playwright's `chromium_headless_shell-1243` (in `%LOCALAPPDATA%\ms-playwright`; `npm i playwright-core` **inside the scratchpad dir**, never in the repo). Serve the repo with `python -m http.server 8000` (or `npx serve`). Use a CDP session (`context.newCDPSession(page)`) with `WebAuthn.enable` + `WebAuthn.addVirtualAuthenticator({ options: { protocol:"ctap2", transport:"internal", hasResidentKey:true, hasUserVerification:true, isUserVerified:true, hasPrf:true } })`. Scenarios, each with a screenshot saved to the scratchpad:
  1. Fresh profile -> onboarding -> PIN 1234 twice -> fingerprint step appears -> "Use fingerprint" -> toast -> accounts step.
  2. `page.reload()` -> home renders with **no** lock screen.
  3. New context (no sessionStorage) same IDB is not possible across contexts — instead, in the same page run `sessionStorage.clear(); location.reload()` -> lock screen in **bio** variant -> virtual authenticator auto-resolves -> home.
  4. Set `isUserVerified:false` on the virtual authenticator (`WebAuthn.setUserVerified`), reload -> get() fails -> keypad shown with fingerprint key -> type 1234 -> home.
  5. Settings -> Fingerprint unlock "On" -> Turn off -> row shows "Off" -> Set up needs PIN -> succeeds.
  6. Change PIN 1234 -> 5678 -> reload with cleared sessionStorage -> bio unlock still works (re-wrap happened).
  7. Disable PIN -> `localStorage["batwa.bio"]` is absent and no fingerprint row.
  8. Viewport 360x640 and 390x844: no horizontal scroll, keypad + chip fit without page scroll.
  Headless Chromium may also refuse `get()` without a gesture — drive the flow through real `page.click()` on the fingerprint button, never via `page.evaluate(() => navigator.credentials.get(...))`.
  If a scenario cannot be automated (e.g. CDP `hasPrf` unsupported in this Chromium build), say exactly which and what was verified manually or not at all.

## 5. Acceptance checklist

- Blob format, backup format, sync payload unchanged (diff `sync.js` shows no format change).
- PIN key is still non-extractable in memory; raw bits exist only transiently during enrol/rewrap/unwrap and are zeroed.
- No PIN or key ever written to `console`, `localStorage`, or `sessionStorage` (`localStorage` holds only `"1"/"0"` hints; `sessionStorage` holds only a random id).
- Refresh keeps the app unlocked; closing the PWA/tab locks; >60 s background locks.
- Bio-first lock screen auto-launches, falls back to keypad on cancel with a fingerprint key, stops auto-launching after 3 failures.
- Offer chip on the PIN screen, onboarding step, Settings enable/manage, post-`enablePin` prompt all work; disabling PIN removes enrolment.
- `sw.js` cache bumped, new files precached; `node --check` clean; smoke screenshots produced.

## 6. Sources

- MDN, WebAuthn extensions (`prf`, `largeBlob`): https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions
- MDN, `PublicKeyCredential.getClientCapabilities()`: https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredential/getClientCapabilities_static
- Chromium Intent to Ship, WebAuthn PRF extension: https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI
- Chrome blog, passkeys updates in Chrome 129 (`hints`): https://developer.chrome.com/blog/passkeys-updates-chrome-129
- Yubico, Developer's guide to PRF (HKDF derivation): https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html
- Corbado, passkeys + PRF on Android / Chrome 147 note: https://www.corbado.com/blog/passkeys-prf-webauthn
- Corbado, WebAuthn error handling (`NotAllowedError` heuristics): https://www.corbado.com/blog/webauthn-errors
- Chrome Status, largeBlob (not on Android): https://chromestatus.com/feature/5657899357437952
- MDN, `Window.sessionStorage` (restore caveat): https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage
- Google, passkeys developer docs: https://developers.google.com/identity/passkeys
