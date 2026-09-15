# Batwa — Personal Budget PWA

A private, offline-first budget tracker. PIN-locked, AES-encrypted, installable to your phone's home screen. No build step, no framework, no server — your data lives in your phone's IndexedDB and never leaves it unencrypted.

## ⚠️ Important: it can't run from `file://`

Service workers (the thing that makes Batwa installable and offline-capable) **do not run when you double-click `index.html`**. The app must be served over `https://` or `localhost`.

### Option A — Local testing

From this folder, run either:

```bash
npx serve
# or
python3 -m http.server 8000
```

Then open `http://localhost:3000` (serve) or `http://localhost:8000` (python) in your browser.

### Option B — Real use on your phone (recommended)

Deploy the folder to any free static host — no account gymnastics needed:

| Host | How |
|---|---|
| **Netlify Drop** | [app.netlify.com/drop](https://app.netlify.com/drop) — drag the folder onto the page, done |
| **GitHub Pages** | push this folder to a repo → Settings → Pages → deploy from branch |
| **Cloudflare Pages** | create project → direct upload → drag the folder |
| **Vercel** | `npx vercel` in this folder |

Open the deployed URL on your phone, then:

- **Android (Chrome):** tap the "Install app" prompt, or the banner inside Batwa, or ⋮ → *Add to Home screen*
- **iPhone (Safari):** Share button → *Add to Home Screen*

It opens full-screen without browser chrome and works fully offline afterwards.

**Privacy note:** deploying doesn't upload your data. Entries live in your phone's IndexedDB, encrypted with your PIN. The host only serves the app's files.

## Your PIN is the key — literally

The 4-digit PIN derives the AES-256 encryption key (PBKDF2, 150k iterations). **There is no recovery.** If you forget the PIN, the data is mathematically gone. Keep an export backup (Settings → Backup → Export).

Fingerprint unlock is optional and sits on top of the PIN: your phone's fingerprint (via WebAuthn PRF) opens a sealed copy of the same key, so the PIN is still the only thing that can recover the data. Turn it off any time in Settings → Security; refreshing the page keeps Batwa unlocked, closing it does not.

## Accounts (JazzCash, banks, cash…)

Add your real accounts in Settings → Accounts (or straight from the home screen). Pick a logo (JazzCash, Easypaisa, NayaPay, SadaPay, Meezan, UBL, HBL, Bank Alfalah, MCB, cash…), optionally enter the current balance, and every Add Money / Add Expense sheet lets you pick which account the money moved through. Home shows a swipeable card per account with its live balance.

**Fix balance:** forgot to log some spending? Open an account card → *Fix balance* → type what the account really has. The difference is saved as a visible "Balance fix" entry (flagged as an adjustment in History), so your records stay honest and undoable.

## The four tabs

| Tab | What's there |
|---|---|
| **Home** | The three balances (blur toggle), your account cards, upcoming expenses, quick add |
| **Reports** | Month summary, spending breakdown by category or title, spending patterns (weekday, month phase, daily pace), worth-watching callouts, 6-month trend, fixed vs one-off |
| **History** | Every transaction for a month, filterable by kind / status / account / category. Tap a row to edit it |
| **Settings** | Accounts, cloud sync, backup, PIN, categories, install |

Adding an expense or income offers **Recent** chips under the title field — tap one to refill the title, amount, and category from the last time you logged it.

## Optional cloud sync (JSONBin)

1. Create a free account at [jsonbin.io](https://jsonbin.io)
2. Create a bin — bins can't be empty, so paste this starter JSON (also copyable inside the app's JSONBin setup sheet):

```json
{ "app": "batwa", "version": 1, "updatedAt": null, "salt": null, "cipher": null }
```

3. Copy the **Bin ID** and your **X-Master-Key**, then in Batwa: Settings → Cloud sync → JSONBin setup

Sync is fully automatic once configured: on open, ~3s after any change, when connectivity returns, and when the app comes back to the foreground. The pill next to the greeting shows the live status (✓ synced / ● pending / ↻ syncing / ⚡ offline — tap it to sync now). Transient failures retry themselves; conflicts always ask you.

Only the **encrypted blob** is uploaded — unreadable without your PIN. Conflicts (both devices changed) always ask you; nothing is silently overwritten. Note the keys are stored in the app's local storage, so don't share your deployed URL publicly if the bin is private.

## Project layout

```
index.html            app shell
manifest.webmanifest  PWA manifest (icons, shortcuts)
sw.js                 service worker — precaches the shell, cache-first offline
css/                  tokens (design system) / base / components
js/                   app, db (IndexedDB), crypto (PBKDF2+AES-GCM), auth (PIN),
                      ledger (balances + recurrence), sync (JSONBin)
js/ui/                home, reports, settings, modals, charts, toast
js/vendor/gsap.min.js animations (self-hosted, works offline)
fonts/                Outfit variable font (self-hosted)
icons/                favicon + PWA icon set
branding/             logo source + brand plate (not needed at runtime)
```

## Updating a deployed version

Bump the cache name in `sw.js` (`batwa-v1` → `batwa-v2`) when you change files. Users get a "New version ready · Reload" toast — nothing updates silently mid-session.
