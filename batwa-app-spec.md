# Personal Budget Tracker — PWA Build Specification

## What to build

An **installable Progressive Web App** — a proper multi-file project, not a single HTML file. It installs to the phone's home screen, opens without browser chrome, and works fully offline.

No build step, no bundler, no npm install. Plain ES modules loaded natively by the browser (`<script type="module">`). It must run by serving the folder with any static server.

### Hard constraint to tell the user about

Service workers **do not run from `file://`**. This app cannot be opened by double-clicking `index.html`. It needs to be served over `https://` or `localhost`. Include a `README.md` in the project explaining both paths:

- **Local testing:** `npx serve` or `python3 -m http.server` then open `localhost`
- **Real use (recommended):** deploy the folder to GitHub Pages, Netlify Drop, Cloudflare Pages, or Vercel — all free, all static, drag-and-drop. Then open that URL on the phone and "Add to Home Screen."

Everything still stays private: the data lives in the phone's IndexedDB, encrypted, and never touches the host.

---

## File structure

```
budget-app/
├── index.html
├── manifest.webmanifest
├── sw.js                    ← service worker (must be at root scope)
├── README.md
├── css/
│   ├── tokens.css           ← design tokens: color, type, spacing, radius, shadow
│   ├── base.css             ← reset, typography, layout primitives
│   └── components.css       ← cards, sheets, buttons, inputs, nav, charts
├── js/
│   ├── app.js               ← entry point, boot sequence, routing
│   ├── db.js                ← IndexedDB wrapper
│   ├── crypto.js            ← PBKDF2 + AES-GCM
│   ├── auth.js              ← PIN set / verify / change, lock screen
│   ├── ledger.js            ← entries CRUD, balance math, recurrence engine
│   ├── sync.js              ← JSONBin push/pull/conflict
│   ├── ui/
│   │   ├── home.js
│   │   ├── reports.js
│   │   ├── settings.js
│   │   ├── modals.js        ← add money / add expense / confirm sheets
│   │   ├── charts.js
│   │   └── toast.js
│   └── util/
│       ├── format.js        ← currency, compact numbers, relative dates
│       └── dom.js           ← small helpers, no framework
└── icons/
    ├── icon-192.png
    ├── icon-512.png
    ├── icon-maskable-192.png
    ├── icon-maskable-512.png
    ├── apple-touch-icon-180.png
    └── favicon.svg
```

Keep modules genuinely separated — no single 2000-line file. Each UI module owns its own render and event wiring.

---

## Who it's for

One person tracking their own money. Primary device is a **phone**; desktop is secondary but must not look broken. Currency is **PKR (Rs)**, formatted with commas. Keep the currency symbol and locale in one config constant.

---

## 1. Core concept

The app is a **single ledger** of entries. Every entry is either:

- **Income** — money that came in
- **Expense** — money going out

Expenses have a lifecycle: `pending` → `paid`. This drives the whole app, because a pending expense is money still physically in the user's pocket that is already spoken for.

### The three balances (the heart of the app)

| Balance | Meaning | Formula |
|---|---|---|
| **Total Balance** | What the user physically has | total income − total *paid* expenses |
| **Committed** | Money promised to pending expenses | sum of all `pending` expense amounts |
| **Free to Spend** | The number that actually matters | Total Balance − Committed |

All three sit at the top of the home screen. **Free to Spend** is the hero — largest, most prominent.

If Free to Spend goes negative it must be unmistakable: color shift plus a plain line like "You're Rs 2,400 over what you have."

---

## 2. Data model

```js
// Entry
{
  id: string,              // uuid
  kind: "income" | "expense",
  title: string,           // "Hostel fees", "Salary", "Bike tuning"
  amount: number,
  category: string,
  recurrence: "one-time" | "weekly" | "monthly",
  dueDate: string | null,  // ISO date; expenses only
  status: "pending" | "paid",   // income is always "paid"
  note: string,
  createdAt: string,
  paidAt: string | null,
  seriesId: string | null  // links auto-generated recurring instances
}
```

### Categories
Default list, editable in Settings: Fees, Rent/Hostel, Food, Transport, Education, Bills, Health, Shopping, Savings, **Others**. `Others` always exists and is the fallback.

### Recurrence engine (`ledger.js`)
- A `monthly` or `weekly` expense is a **template**; the app generates the next instance automatically.
- On app open: for each series, if the next due date has passed or falls within the next 7 days and no instance exists for that period, create a `pending` instance.
- Never auto-mark anything paid. The user always confirms.
- Deleting a recurring expense asks: *this one* or *this and all future*.

---

## 3. Storage

**IndexedDB** is the primary store (`db.js`). Hand-rolled wrapper or the tiny `idb` module — no heavy dependency.

Stores:
- `entries` — the ledger
- `meta` — settings, PIN salt + verifier, categories, JSONBin config, `lastSyncedAt`, schema version

Entry data is written **encrypted**. No plaintext amounts on disk.

Include a schema `version` field and a migration path so future changes don't corrupt existing data.

---

## 4. PIN lock + encryption

- First launch: user sets a **4-digit PIN**, entered twice.
- Every app open (and on resume after the app has been backgrounded past a timeout): full-screen lock with a large **custom numeric keypad**. Do not use a text input that summons the OS keyboard.
- The PIN is not a screen gate. Derive a key with **PBKDF2** (Web Crypto, ≥100k iterations, random salt in `meta`) and encrypt the entries payload with **AES-GCM**. A wrong PIN means the data cannot be decrypted at all.
- Store only salt + a verification token. Never the PIN.
- "Change PIN" in Settings re-encrypts existing data.
- Settings must warn clearly: **there is no PIN recovery.** Losing it loses the data. Tell the user to keep an export backup.
- After 10 wrong attempts, add an escalating delay. Never wipe data.
- Optional **fingerprint unlock** (WebAuthn PRF): the platform authenticator's PRF output is run through HKDF into a wrap key that seals a copy of the PIN-derived key. The PIN stays the only key to the data; the fingerprint just hands it over. Removing it needs no PIN (it only deletes the sealed copy); adding it back needs the PIN once. No PRF support means no enrolment — a fingerprint that only gates the UI would give it no cryptographic role.
- A **refresh keeps the app unlocked**: the non-extractable key is parked in `meta.session` under a random id held in `sessionStorage`, so it survives reload (including the service worker's own `location.reload()`) but dies with the tab. It also expires after 24 h and obeys the same 60 s background rule.

---

## 5. PWA requirements

### `manifest.webmanifest`
- `name`, `short_name`, `description`
- `start_url: "./"`, `scope: "./"`
- `display: "standalone"`
- `background_color` and `theme_color` matching the app's palette
- `orientation: "portrait"`
- Icons: 192 and 512, plus **maskable** variants (Android crops non-maskable icons badly)
- `categories: ["finance", "productivity"]`
- Optionally `shortcuts` for "Add Expense" and "Add Money" (long-press the home screen icon)

### `sw.js`
- **App shell precache** on install: HTML, CSS, JS, icons, manifest.
- **Cache-first** for the shell so cold launches are instant offline.
- **Network-only** for JSONBin API calls — never cache sync responses.
- Versioned cache name (`budget-v1`). On activate, delete old caches.
- Implement an update flow: when a new SW is waiting, show a toast — "New version ready · Reload" — that calls `skipWaiting` and reloads. Do not silently update mid-session.
- The SW never touches user data. It caches files only.

### `index.html`
- Correct viewport meta, `theme-color`, manifest link, `apple-touch-icon`, and `apple-mobile-web-app-capable` for iOS standalone mode.
- Safe-area insets handled (`env(safe-area-inset-*)`) for notch and home bar.

### Install experience
- Capture `beforeinstallprompt` and surface a tasteful "Install app" button in Settings (and once, dismissibly, on the home screen). Do not nag.
- **iOS does not fire that event.** Detect iOS Safari and show short manual instructions instead: Share → Add to Home Screen.
- Hide all install UI when already running standalone (`display-mode: standalone`).

### Offline behavior
- The app must be fully functional offline: add, edit, mark paid, view reports.
- A subtle persistent indicator when offline. Sync is queued and fires when connectivity returns.

### Icons
Generate a simple, distinctive mark for the app — flat, high contrast, readable at 48px. Export every size listed in the file structure. Maskable versions need the mark inside the safe zone (center 80%).

---

## 6. Home screen

### 6.1 Balance section

Three balances, visually distinct **by color** — choose the palette yourself, but the meaning must read at a glance:
- Total Balance — neutral / calm
- Committed — cautionary
- Free to Spend — the positive hero, with a clear alarm state when negative

**Blur toggle (required):**
- An eye icon in the balance area.
- **On every launch and refresh, all three balances start blurred** (CSS blur, not hidden — the shape of the number stays).
- Tapping the eye reveals them. Session-only: relaunching re-blurs. Never persist "revealed."
- **Only the three balances blur.** Expense cards, reports, and history stay visible.

**Compact number format (required):**
- `54,302` → `54.3k`; `1,240,000` → `1.24M`. One decimal, trimmed if `.0`.
- Under ~1,000 shows the full number.
- On **tap (mobile) or hover (desktop)**, a tooltip shows the exact amount: `Rs 54,302`. It must work on touch — tap opens, tap elsewhere closes.
- Applies to the three balances and large summary figures. Individual expense cards always show exact amounts.

### 6.2 Upcoming expenses

Below the balances: scrollable **cards** for `pending` expenses, sorted by due date (soonest first).

Each card: title, exact amount, due date plus a human hint ("in 3 days", "Tomorrow", "Overdue by 2 days"), category, recurrence marker.

**Recurrence must be visually distinguishable** — one-time vs weekly vs monthly identifiable without reading text. Combine accent color, a small badge, and/or a left border stripe. Pick one system and apply it everywhere recurrence appears.

**Overdue** items get their own treatment and sort to the top.

Card actions in one tap — swipe or inline row, your call: **Mark paid**, **Edit**, **Delete**.

Marking paid should feel good: a small confirmation animation and an immediate, visible balance update.

Empty state is an invitation to add the first expense, not a blank screen.

### 6.3 Primary actions

Two obvious, always-reachable actions: **Add Money** and **Add Expense**. On mobile, thumb-reachable — bottom bar or FAB. Never buried in a menu.

---

## 7. Add / Edit modals

Bottom sheets on mobile, centered modals on desktop.

**Input styling is a hard requirement:** large, soft, generously padded fields, rounded corners, clear focus states. Comfortable to tap on a phone. No cramped default form controls.

**Add Money:** Amount, Description, Date (defaults today), optional Category.

**Add Expense:** Amount, Title, **Type: One-time / Weekly / Monthly** as a segmented control (not a dropdown), Due date, Category, optional Note, and a "Mark as already paid" toggle for logging past spending.

Amount fields use `inputmode="decimal"` so the numeric keyboard opens. Font size ≥16px to stop iOS zoom-on-focus.

Validate inline and specifically: "Enter an amount", not "Invalid input."

---

## 8. Reports page

A separate view (bottom nav).

- **Month selector** — browse any past month.
- **Month summary:** total in, total out, net, and change vs previous month.
- **Spending by category** — donut or horizontal bars, plus a ranked list with amounts and percentages.
- **Monthly trend** — line or bar over the last 6 months.
- **One-time vs recurring split** — the fixed baseline cost vs one-off spending.
- **Full transaction history** for the month, filterable by kind / category / status, newest first.
- One or two plain-language insight lines derived from real data ("Food was your biggest category this month at Rs 8,400").

Charts: hand-drawn SVG or canvas in `charts.js`. If a library is used, it must be a single small file precached by the SW — nothing that breaks offline.

Every chart needs a sensible empty state for months with no data.

---

## 9. JSONBin.io sync (`sync.js`)

- Settings holds **Bin ID** and **X-Master-Key**, entered once, stored in `meta`.
- **Sync now** button, plus auto-sync on app open and after any data change (debounced ~3s).
- Show `lastSyncedAt` as "Synced 4 minutes ago"; clearly flag unsynced or offline.
- **Push the encrypted blob**, never plaintext. Data on JSONBin is unreadable without the PIN.
- Store `version` and `updatedAt` with the payload. On open, compare remote vs local:
  - remote newer → offer to pull
  - local newer → push
  - both changed since last sync → **never silently overwrite.** Prompt: keep local, keep remote, or download both as files.
- Handle every failure gracefully: no keys, no internet, bad key, rate limit. Sync is an enhancement, never a blocker.
- Note in Settings that the keys live in the app's storage, so the deployed URL shouldn't be shared publicly if the bin is private.

### Manual backup (also required)
- **Export** — download all data as `.json` (offer encrypted and plain; warn on plain).
- **Import** — restore from a file, with a confirm step stating whether it merges or replaces.

---

## 10. Visual direction

Reference feel: **JazzCash / NayaPay / modern fintech wallet apps.**
- A gradient-led identity — gradients on the balance hero and primary actions, restrained elsewhere.
- Card-based layout, generous rounded corners, soft layered depth.
- Confident, readable numerals. Money is the content; let typography carry it.
- Purposeful micro-interactions: sheet slide-up, balance count-up on reveal, tap feedback, mark-paid confirmation.

**You choose the exact palette, typefaces, gradients, spacing scale, and iconography.** Don't ask — make opinionated choices and commit. Put every one of them in `tokens.css` as custom properties and derive everything from there.

Fonts should be self-hosted or system-stack so the app looks right offline. If a webfont is used, precache it.

The non-negotiable: **it must not look like a default form app.** It should look like something worth opening.

### Layout

**Mobile (primary):**
```
┌─────────────────────────┐
│ Header: greeting  [eye] │
├─────────────────────────┤
│ ╭─────────────────────╮ │
│ │  FREE TO SPEND      │ │  ← gradient hero card
│ │  ▓▓▓▓▓ (blurred)    │ │
│ │  Total    Committed │ │  ← two smaller figures
│ ╰─────────────────────╯ │
├─────────────────────────┤
│  Upcoming               │
│  ┌───────────────────┐  │
│  │▌Hostel fees       │  │  ← stripe = recurrence
│  │ Rs 3,000 · Monthly│  │
│  │ Due in 4 days     │  │
│  └───────────────────┘  │
│  ┌───────────────────┐  │
│  │▌Bike tuning       │  │
│  └───────────────────┘  │
├─────────────────────────┤
│ [+ Money]   [+ Expense] │
├─────────────────────────┤
│  Home    Reports   ⚙    │  ← bottom nav
└─────────────────────────┘
```

**Desktop:** two columns — balances and quick actions left, upcoming and recent activity right. Cap max width; don't stretch cards across a 27" monitor. Reports gets full width.

---

## 11. Quality floor

- Responsive from 320px up.
- Touch targets ≥ 44px.
- Visible keyboard focus; modals trap focus and close on Escape.
- `prefers-reduced-motion` respected.
- No horizontal scroll on mobile, ever.
- Safe-area insets handled.
- Destructive actions (delete, replace-on-import, change PIN) always confirm.
- Toast for every completed action, with **Undo** on delete and mark-paid.
- No unhandled error ever lands the user on a blank screen — catch and show something readable.
- Back button / hardware back should close an open sheet rather than exiting the app (use history state for routing).

---

## 12. Build order

1. Project scaffold, `index.html`, tokens, manifest, service worker, install flow — verify it installs and launches offline before anything else
2. `db.js` + `crypto.js` + `auth.js` — storage, encryption, PIN lock
3. Home screen: three balances, blur toggle, compact numbers + tooltip
4. Add Money / Add Expense sheets
5. Upcoming cards: mark paid, edit, delete, undo
6. Recurrence engine
7. Reports + charts
8. Export / Import
9. JSONBin sync with conflict handling
10. Polish: animation, empty states, iOS quirks, edge cases

Deliver the full folder plus a `README.md` covering local run, deploy, and install-to-home-screen for both Android and iOS.