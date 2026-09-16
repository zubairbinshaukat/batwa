# Daily helpers: bill reminders, backup nudge, category limits, quick math + SMS share target

Status: approved plan, ready to implement. Branch: `develop`. Do not commit; leave changes in the working tree for review.

Four independent features. Implement in the order given; each is shippable alone.

## 0. Context (what exists today)

- Plain ES-module PWA, no build step, no npm. `el()` builder + `anim()/animTo()` (GSAP, reduced-motion aware) from `js/util/dom.js`; `icon(name, size)` / `catIcon()` from `js/ui/icons.js`; `fmtMoney/fmtCompact/fmtNum/isoDate/daysUntil/thisMonth` from `js/util/format.js`; sheets via `openSheet(title, build)`, `confirmSheet`, `chooseSheet` in `js/ui/modals.js`; `toast(text, { icon })`.
- **Ledger** (`js/ledger.js`): `state = { entries, accounts, categories }`, `onChange(cb)`, `saveCategories(cats)` persists to meta `categories`. `pendingExpenses()` = pending expenses, overdue first. `monthSummary(ym)` -> `{ income, spent, net, byCat, recurringOut, onceOut, list }` (spent = paid expenses only, transfers excluded). `balances()` -> `{ total, committed, free }`. Meta store: `getMeta/setMeta` in `js/db.js`.
- **Accounts**: `{ id, name, kind }`; `kind` is a key of `LOGO_KINDS` in `js/ui/accounts.js` (jazzcash, easypaisa, nayapay, zindigi, meezan, ubl, hbl, alfalah, mcb, allied, cash, bank, sadapay, upaisa, alhabib, askari, faysal, nbp, bop, habibmetro, jsbank, soneri, scb, dib, bankislami, albaraka). `logoTile(kind, size)`, `accountName(id)`.
- **Forms** (`js/ui/modals.js`): `amountField(value)` builds `input.input-amount` (`type=text inputmode=decimal`) with an `Rs` prefix; `parseAmount(raw)` strips `,`/spaces and `parseFloat`s. `buildExpenseForm(entry)` / `buildMoneyForm(entry)` take an existing entry for edit mode; `addExpenseSheet(entry=null)`, `addMoneySheet(entry=null)`, `quickAddSheet(kind)`. `accountPicker(selectedId, onChange)`: `selectedId === undefined` -> last used account; `null` -> "No account" chip active. `suggestionRow()` fills title/category/account from recent entries. `lastAccountId` is session memory.
- **Boot** (`js/app.js`): `boot()` -> `unlockFlow()` -> after render handles `?action=add-expense|add-money` from manifest shortcuts, then `history.replaceState(..., "./")`. `mountInstallBanner()` renders `.install-banner` into `#install-slot` on Home (dismiss stored as meta `installDismissed`). `onChange(() => { renderView(); scheduleSync(); updateSyncPill(); })`. Auto-lock re-runs `unlockFlow()`.
- **Home** (`js/ui/home.js`): `renderHome(view)` paints `#install-slot`, hero, `#acc-slot`, `#expected-income-wrap`, `#upcoming`. Balances are blurred until the eye is tapped (`revealed`, session-only).
- **Reports** (`js/ui/reports.js`): `renderCatPanel(panel, sum)` = donut + `.cat-row` list (dot, label, `.cat-bar-track > .cat-bar` = share of total, `.cat-amt`, `.cat-pct`). `buildInsights(a, sum, prev)` returns `[{ id, tone: good|info|caution, weight, html, pills? }]`; `renderInsights` shows top 2 non-caution, `renderWatch` shows top 3 caution in a "Worth watching" card. `CHART_COLORS` from `js/ui/charts.js`. Colour tokens: `--c-pos`, `--c-warn`, `--c-neg`, `--c-violet`, `--c-muted`, soft variants `--c-*-soft`.
- **Settings** (`js/ui/settings.js`): `row(key, label, value, onClick)` with the `ICONS` map; Backup group has `Export data` (-> `exportSheet`: encrypted/plain) and `Import from file`; `categoriesSheet()` renders `.cat-pill` chips with an `x` and an add input.
- **Sync/backup** (`js/sync.js`): `exportEncrypted()` / `exportPlain()` write `exportedAt` into the file but never persist it; `getSyncConfig()` -> `{ binId, masterKey }`; `getSyncState()` -> `{ state: off|offline|syncing|pending|synced, text }`.
- **Manifest** (`manifest.webmanifest`): `start_url "./"`, `scope "./"`, `display standalone`, two `shortcuts` (`./?action=add-expense`, `./?action=add-money`). No `share_target`, no `launch_handler`.
- **Service worker** (`sw.js`): `CACHE = "batwa-v17"`; navigations are served cache-first from `./index.html` regardless of query string, so a `./?text=...` launch works offline. Precache list `SHELL`.
- Handwriting tips font: `--font-hand` (Caveat) is the house style for one-line tips.

## 1. Feature A — bill reminder notification (replaces the icon badge)

**Why not a badge.** Chrome for Android does not implement the Badging API (`navigator.setAppBadge`), so an installed Batwa can never draw a count on its icon there. Android does draw its own dot on the launcher icon when the app has an unread notification. The user chose: post a local notification from the service worker via **Periodic Background Sync** ("2 bills due today"), which also yields that dot.

**Behaviour.**
- Settings -> a new group **Reminders** with a row `Bill reminders` (value `On` / `Off` / `Unavailable`). Turning it on: requests notification permission, registers periodic sync tag `batwa-due` with `minInterval: 12 * 60 * 60 * 1000`, writes meta `remindersOn = true`, writes the first `dueSchedule`, shows toast. A second row `Send a test reminder` posts one immediately via `registration.showNotification` so the user sees what it looks like (and so the smoke test can verify the path).
- Turning it off: `periodicSync.unregister("batwa-due")`, delete meta `dueSchedule`, `remindLastDay`, set `remindersOn = false`.
- Copy under the card (xsmall muted): "Reminders run in the background even when Batwa is closed. To do that, only the **due dates and how many bills fall on each** are kept outside the encrypted ledger — never titles or amounts. Android decides how often it runs (usually once or twice a day) and only for apps you actually use."
- The notification: title `Batwa`, body `1 bill due today` / `3 bills due today` / `2 overdue bills` / `2 overdue, 1 due today`, `tag: "batwa-due"` (replaces, never stacks), `icon: icons/icon-192.png`, `badge: icons/icon-maskable-192.png`, `data: { url: "./" }`. At most **one per calendar day** (`remindLastDay` = "YYYY-MM-DD"). Tapping focuses an open Batwa window or opens `./`.
- `Unavailable` when `!("serviceWorker" in navigator) || !("Notification" in window) || !("periodicSync" in ServiceWorkerRegistration.prototype)` (Firefox, Safari, and Chrome when the app is not installed — Chrome only exposes periodic sync to installed PWAs; show the reason "Install Batwa to the home screen first" when `getInstallState() !== "standalone"`). Permission denied -> row stays `Off`, toast explains.

**Implementation.**
- `js/ledger.js`: `export function dueSchedule(entries, today = isoDate())` -> `[{ date, count }]` for pending expenses with a `dueDate` (overdue collapsed into their own real dates; only dates within the last 90 and next 60 days, sorted). In `saveLedger()`, if `remindersOn` (module flag loaded in `loadLedger` from meta) -> `setMeta("dueSchedule", dueSchedule(state.entries))`. Pure part fixture-tested.
- New `js/reminders.js` (page side): `remindersSupported()`, `remindersState()` -> `"on"|"off"|"unavailable"|"not-installed"`, `enableReminders()`, `disableReminders()`, `sendTestReminder()`, `dueSummary(schedule, today)` -> `{ overdue, today, text }` (**shared with the SW by duplicating the 15-line function in `sw.js`, with a comment pointing at the canonical copy** — the SW is a classic script and cannot import modules). `enableReminders` also posts `dueSchedule` immediately so the first background run has data.
- `sw.js`:
  - `self.addEventListener("periodicsync", (e) => { if (e.tag === "batwa-due") e.waitUntil(checkDue()); })`.
  - `checkDue()`: open IDB `batwa` (same name/version as `js/db.js`, read-only, no `onupgradeneeded` work), read meta `dueSchedule`, `remindLastDay`, `remindersOn`; compute today's local date; if `!remindersOn` return; if `remindLastDay === today` return; `{ overdue, today, text } = dueSummary(...)`; if nothing due return; `showNotification`, then write `remindLastDay = today`.
  - `notificationclick`: `e.notification.close()`; `clients.matchAll({ type: "window", includeUncontrolled: true })` -> focus the first Batwa client or `clients.openWindow("./")`.
  - Bump `CACHE` (see §4.2).
- `js/ui/settings.js`: the Reminders group + the two rows + copy. Uses `getInstallState()` already imported.
- Fixture: `dueSummary` for combinations (0/0, 2 overdue/0, 0/1, 2/1) and `dueSchedule` grouping.
- Honest limits (also written into the Settings copy and the spec): Chrome decides when periodic sync runs (site engagement, network, battery); there is no fixed time of day; it never fires in a browser tab, only for the installed app.

## 2. Feature B — backup nudge (the PIN has no recovery)

**Behaviour.**
- Every export (encrypted or plain) records meta `lastExportAt` (ISO).
- Home shows a soft banner in `#install-slot`'s sibling slot `#nudge-slot` (new, directly under `#install-slot`) when ALL hold: ledger has >= 10 entries; cloud sync is not configured (`binId` or `masterKey` empty); `lastExportAt` is missing or older than 30 days; `backupNudgeSnoozedUntil` (meta) is absent or in the past; the install banner is **not** currently showing (one banner at a time — install wins).
- Copy (PIN mode): **"Back up your data"** / "There's no PIN recovery — a backup file is the only way back. Last backup: never | 12 Aug." Device mode: same title / "Your phone is the only copy. Last backup: …".
- Buttons: `Export` -> `exportEncrypted()` (PIN mode) or `exportPlain()`… no: always `exportEncrypted()` (device mode exports carry their own key, see `keyMaterial()`), then toast and remove the banner. `Later` -> `backupNudgeSnoozedUntil = now + 14 days`, banner fades out.
- Settings -> Backup: `Export data` row's value becomes `Last: 12 Aug` / `Never` (uses `shortDate`), updated by `refresh()` after an export from the sheet.

**Implementation.**
- `js/sync.js`: in `exportEncrypted` and `exportPlain`, after `downloadJSON`, `await setMeta("lastExportAt", new Date().toISOString())`. Export `getLastExportAt()`.
- New `js/nudge.js` (pure decision + render helper): `shouldNudgeBackup({ entryCount, syncConfigured, lastExportAt, snoozedUntil, now })` -> boolean; fixture-tested. `mountBackupNudge(slot)` in `js/ui/home.js` (or `app.js` next to `mountInstallBanner`, whichever keeps imports acyclic — `home.js` already imports sync? check; if not, put it in `app.js` alongside the install banner and export nothing).
- CSS: `.nudge-banner` = `.install-banner` layout but on `var(--c-warn-soft)` with ink text (not the violet gradient) so the two are distinguishable. Icon `alert`. Include the same dismiss affordance.

## 3. Feature C — per-category monthly limits

**Behaviour.**
- Settings -> Categories sheet becomes a list: each row = category name, a small `Rs` limit input (`inputmode=numeric`, blank = no limit), and the existing `x` (not for Others). Limits save on `change`/blur. Add-category input stays at the bottom. "Others" can have a limit too.
- **Reports -> Spending breakdown -> Category**: for a category with a limit, the row gains a second line: thin track filled `min(spent/limit, 1)`, coloured `--c-pos` under 80 %, `--c-warn` 80–100 %, `--c-neg` over; text right-aligned `Rs 4,200 of 6,000` and, for the current month only, `9 days left`. Over: `Rs 300 over`. Categories with a limit but no spend this month still show (`Rs 0 of 6,000`) so the user sees the plan. Sorting stays by spend.
- **Insights**: new caution insights `limit-over` (weight 95, one per over category, pills = category) and `limit-near` (weight 70, >= 80 % with >= 3 days left in the month). Good insight `limit-ok` (weight 15) when every limited category is under 80 % and at least one exists. Text examples: "**Food** is **Rs 300 over** its Rs 6,000 limit." / "**Transport** has used **84 %** of its limit with 9 days left."
- **Home**: only when at least one limit exists. A compact card `Monthly limits` between `#acc-slot` and `#expected-income-wrap` (in `.home-right` above Expected income, so it sits with the actionable list): one line per limited category (max 4, sorted by usage desc, then `+2 more in Reports` link that `go("reports")`s), each line = `catIcon` + name + mini track + `4.2k / 6k` in `fmtCompact`. Amounts follow the Home blur state (`.blurable` + `moneySpan` pattern is for hero only — here just apply `is-blurred` class to the card when not revealed, same as the accounts row). No limits set -> card not rendered at all, no empty state.

**Implementation.**
- `js/ledger.js`: `state.limits = {}` (category -> number). `loadLedger` reads meta `catLimits`. `export async function saveLimits(map)` (drop non-positive / non-existent categories, persist, `emit()`). `saveCategories` prunes limits of removed categories. Export `limitStatus(ym, { today })` -> `[{ category, limit, spent, ratio, left, over, daysLeft }]` for categories with a limit (`spent` from `monthSummary(ym).byCat`). Pure enough to fixture-test given `state`.
- `js/ui/settings.js` `categoriesSheet`: rows `.cat-limit-row` (`catIcon`, name, `input.input.input-sm` with `Rs` prefix, `x`); debounce-free: save on `change`. Validation: digits and commas only; empty clears.
- `js/ui/reports.js`: `renderCatPanel(panel, sum)` gets `limits` via `limitStatus(ym)`; add the second line; `buildInsights` adds the three insight kinds (it has `a.ym`, `a.daysElapsed`; days left = days in month − daysElapsed for the current month, else 0).
- `js/ui/home.js`: `renderLimitsCard(slot)`.
- CSS: `.cat-limit` line (`display:flex; align-items:center; gap:8px; margin:-4px 0 6px 22px; font-size: var(--fs-xs); color: var(--c-muted)`), `.limit-track` (height 4px, radius 2px, `--c-border` bg) + `.limit-fill` (`.is-ok/.is-warn/.is-over`), Home `.limits-card` rows. Settings `.cat-limit-row` grid `auto 1fr 110px auto`.

## 4. Feature D — quick math in the amount field + SMS share target

### 4.1 Quick math

**Behaviour.** The amount field accepts `120+80`, `1500/3`, `2*450-100`, `(300+200)*2`. While the value contains an operator, a small hint under the field shows `= Rs 200`; on blur or submit the field is replaced by the result (2 dp max, rounded). Invalid expression -> the existing "Enter an amount" error. Division by zero / negative / zero result -> error. On touch devices a compact operator row `+ − × ÷` appears under the focused amount field (Android's decimal keypad has no `+`); tapping inserts the operator at the caret and keeps focus.

**Implementation.**
- New `js/util/expr.js` (pure, Node-testable): `evalAmountExpr(str)` -> number | null. Tokeniser + shunting-yard (or recursive descent) over `+ - * / ( )`, digits, `.`, `,` (thousands separators stripped), unicode `×`/`÷`/`−` normalised. **No `eval`, no `Function`.** Max length 64. Returns null on any error.
- `js/ui/modals.js`: `parseAmount(raw)` -> if `/[+\-*/×÷−()]/.test(raw)` use `evalAmountExpr`, else existing path. `amountField()` adds `.amt-hint` (hidden unless expression) and `.amt-ops` row (only when `"ontouchstart" in window`), shown on focus, hidden on blur (after a short delay so a tap registers). On blur: if expression valid, set `input.value = String(result)`.
- CSS: `.amt-hint` (xs, muted, `--font-hand` is fine here as a one-line tip), `.amt-ops` (4 pill buttons, 40px tall, `--c-surface-2`).
- Fixture: 15 expressions incl. malformed ones.

### 4.2 Share target (share a bank/wallet SMS into Batwa)

**Behaviour.**
- Android share sheet (Messages -> long-press SMS -> Share) lists Batwa once installed. Picking it opens Batwa; after the normal unlock (fingerprint/PIN/session) the app renders Home **and** opens a pre-filled sheet on top: **Add Expense** for a debit, **Add Money** for a credit. Every field is editable; Save works as usual. Without a shared payload, boot is unchanged.
- Pre-fill: `amount` (first transaction amount, never the balance), `title` (counterparty or merchant, else `"<Provider> payment"` / `"<Provider> transfer in"`), `account` (see matching), `category` (keyword guess from a small merchant map, only if that category exists; else `Others`), `date` (parsed from the SMS when present, else today). If no amount is found: the expense sheet still opens with the title guessed and a toast "Couldn't read an amount — type it in".
- **Account matching**: 1) brand keyword in the text -> account `kind`; exactly one account of that kind -> pick it. 2) Several of that kind -> use memory meta `shareAccountMemory[kind]` if it points to an existing account, else leave the picker on "No account". 3) No brand (common for traditional banks, whose name is only in the SMS sender ID which Android does not pass along) -> picker left unset, and the form note says "Couldn't tell which account — pick one". When the user saves an entry from a shared prefill, remember `shareAccountMemory[kind] = accountId` (kind = matched kind, skip when none). 4) Only one account in total -> always pick it.
- Query string is cleared with `history.replaceState` before anything else, so a reload never re-opens the sheet.
- iOS Safari does not support share targets; nothing to do there.

**Implementation.**
- `manifest.webmanifest`: add
  ```json
  "share_target": { "action": "./?share=1", "method": "GET", "params": { "title": "title", "text": "text", "url": "url" } },
  "launch_handler": { "client_mode": ["navigate-existing", "auto"] }
  ```
  `action` must stay inside `scope`. `?share=1` marks the launch unambiguously (the SMS body may be empty). `launch_handler` is desktop-only (Chrome 110+) and harmless on Android, where a share is just a navigation of the existing WebAPK task — so read `location.search`, never `launchQueue`.
- New `js/smsparse.js` (pure, no DOM, no ledger import): `parseTransactionSms(text)` -> `{ direction: "debit"|"credit"|null, amount: number|null, balance: number|null, counterparty: string|null, providerKind: string|null, date: "YYYY-MM-DD"|null, categoryGuess: string|null, rejected: null | "otp" | "reversal" | "no-direction" }`, plus `matchAccount(parsed, accounts, memory)` -> `accountId|null` and `PROVIDER_PATTERNS` (kind -> RegExp). Parsing order (from §6, this order matters):
  1. Normalise: collapse whitespace, cap at 2 kB, strip `/-`.
  2. **Reject filters**: `/\b(reversed|failed|declined|unsuccessful|could not be)\b/i` -> `rejected:"reversal"`; `/\bOTP\b|one[- ]time (pass|pin)|do not share/i` -> `"otp"`. A rejected message still opens the expense sheet with nothing but the note filled, plus a toast saying why.
  3. **Blank the balance span** first (`Avl Bal | Available Balance | Remaining Balance | new … balance | Cur Bal | A/C Bal | Bal | Balance` + optional `is|:|=` + amount), capture it as `balance`.
  4. **Blank fee/charges spans** (`fee|charges|service charges|tax|FED|WHT` + amount) — otherwise `Fee Rs 0` steals the amount.
  5. **Amount** = first remaining `(PKR|Rs\.?|RS\.?)\s*NUM`; fallback `NUM\s*(PKR|rupees)`.
  6. **Direction**: credit keywords (`credited|received|deposit(ed)|cash[- ]?in|salary|refund|added to your`) vs debit (`debited|sent|paid|payment of|transferred|withdraw(n|al)|purchase|spent|deducted|charged|was used|POS|ATM`). If both appear, "credited to your (account|wallet)" wins credit; otherwise the earliest keyword wins. Neither -> `rejected:"no-direction"` (OTP/promo/balance-enquiry replies all contain `Rs`).
  7. **Refs stripped** (`TID|Trx ID|TrxID|Txn ID|Ref No|Ref#|RRN|STAN|Auth Code` + token) before counterparty extraction.
  8. **Counterparty**: debit -> `to X` / `at X` / `for X` (biller); credit -> `from X`; never "to your account/wallet". Accept masked numbers (`03xx-xxxxx12`, `****1234`) and ALLCAPS merchants; trim trailing ` PK`, city names are left alone. Title = counterparty, else `"<Provider> payment"` / `"<Provider> transfer in"`, else `"Card purchase"` / `"Money received"`.
  9. **Provider**: brand regex per `LOGO_KINDS` key (`jazz ?cash`, `easy ?paisa`, `nayapay`, `sadapay`, `zindigi`, `meezan`, `\bUBL\b|United Bank`, `\bHBL\b|Habib Bank`, `alfalah`, `\bMCB\b`, `allied bank|\bABL\b`, `askari`, `faysal`, `\bNBP\b|national bank`, `bank of punjab|\bBOP\b`, `habib ?metro`, `JS Bank`, `soneri`, `standard chartered|\bSCB\b`, `dubai islamic|\bDIB\b`, `bank ?islami`, `al ?baraka`, `al ?habib|\bBAHL\b`, `upaisa`). **Nullable**: traditional banks often identify themselves only in the SMS sender ID, which the share sheet does not pass — so the account picker being left unset is the normal case for banks, not an error.
  10. **Date**: `DD-MM-YY(YY)`, `DD/MM/YYYY`, `DD-MMM-YY`; otherwise today. Two-digit years -> 20YY.
  11. **Category guess** (only if that category exists in `state.categories`, else `Others`): Transport ← careem|uber|bykea|indrive|psO|shell|total|fuel|petrol; Food ← foodpanda|kfc|mcdonald|pizza|cafe|restaurant|bakery; Bills ← k-electric|kelectric|lesco|iesco|fesco|gepco|mepco|hesco|sngpl|ssgc|ptcl|nayatel|stormfiber|jazz|zong|telenor|ufone|netflix|spotify|youtube; Shopping ← daraz|amazon|aliexpress|mall|store|mart; Health ← pharmacy|hospital|clinic|lab; Education ← university|college|school|academy|fee.
  - `prefill.note` = the raw SMS (first 300 chars) so the user keeps the source and can spot a mis-read; it is stored encrypted with the entry like any note.
- `js/app.js`: in `boot()` before `unlockFlow()`: `const shared = readSharedPayload()` — only when `share=1` is present; body = `text`, falling back to `url`, then `title` (Android puts the SMS in `text`; `url` is usually empty; if several are present join them with `\n`), then `history.replaceState({ view: "home" }, "", "./")`. After the view renders (same place `?action` is handled): if `shared`, `openSharedSheet(shared)` -> parse -> `addExpenseSheet(null, { prefill })` or `addMoneySheet(null, { prefill })`. Handle it also on the auto-lock path? No: the payload is consumed once at boot.
- `js/ui/modals.js`: `buildExpenseForm(entry, prefill = null)` / `buildMoneyForm(entry, prefill = null)`: when `entry` is null and `prefill` given, seed amount/title/date/category/account (`accountPicker(prefill.accountId ?? undefined)` — `null` means unset, `undefined` means last used). Show a one-line `.form-note is-info` above the form: "Filled from a shared message — check the amount." After a successful save with `prefill.providerKind`, `await rememberShareAccount(kind, accountId)` (meta write; lives in `smsparse.js` or `db.js` helper).
- `sw.js`: add `./js/reminders.js`, `./js/nudge.js`, `./js/smsparse.js`, `./js/util/expr.js`; `CACHE = "batwa-v18"`. Navigation handler already ignores the query.
- Docs: `batwa-app-spec.md` gets a short "Daily helpers" section; README gets "Share a bank SMS to Batwa" and "Quick math" lines.

## 5. Edge cases

| Case | Behaviour |
|---|---|
| Reminders unsupported (Firefox, Safari, not installed) | Settings row `Unavailable` with the reason; nothing registered. |
| Reminders on, then PIN disabled / ledger replaced by import | `saveLedger` rewrites `dueSchedule` on every save, so it follows the data. |
| Periodic sync never fires (low engagement, battery saver) | Nothing we can do; the Settings copy says Android decides. `Send a test reminder` still works for confidence. |
| Notification permission revoked later | The SW cannot read `Notification.permission`; `showNotification` rejects -> caught and ignored. The Settings row re-reads `Notification.permission` on paint and shows `Off` with the hint "Allow notifications for Batwa in Android settings". |
| Nudge while sync configured | Never shown (cloud copy exists). |
| Nudge + install banner both eligible | Install banner only. |
| Export cancelled by the browser (no download) | We cannot detect it; `lastExportAt` still updates. Accept. |
| Limit set, category later deleted | `saveCategories` prunes the limit. |
| Limit on a category with zero spend | Shown in Reports and Home as `0 of X`. |
| Viewing a past month in Reports | Limit line shows `of X` with no "days left"; insights still computed for that month. |
| Quick math `1,500+250` | Commas stripped -> 1750. |
| Quick math trailing operator `120+` | Invalid -> error on submit, hint hidden. |
| Share text without any amount | Expense sheet opens with title guess + toast. |
| Share text that is a credit | Add Money sheet, `status: paid`, date from SMS or today. |
| Shared while locked | Unlock first (fingerprint/PIN), then the sheet opens over Home. |
| Shared while a session is live in an open window | `navigate-existing` reloads that window with the query; session restore keeps it unlocked; sheet opens. |
| Reload after sharing | Query already stripped -> plain Home. |
| Two accounts of the matched kind, no memory | Picker unset; after first save the choice is remembered for that kind. |
| Brand not recognised | Picker unset; title still filled. |
| Text > 2 kB | Only the first 2 kB parsed. |
| OTP / reversal / promo SMS shared | Rejected by the filters; expense sheet opens with only the note filled and a toast "That message isn't a payment" / "That's a reversal — nothing to add". |
| SMS says `Rs 500 … fee Rs 10 … balance Rs 9,000` | Balance and fee blanked first -> amount 500. |
| Amount includes paisa `Rs 1,250.75` | Kept with 2 dp (`parseAmount` already rounds to 2 dp). |

## 6. Research notes (Sept 2026)

### 6.1 Web APIs
- **Web Share Target**: manifest `share_target` with `action` (same-origin, inside `scope`), `method: "GET"`, `params: { title, text, url }` (values = query-parameter names). Android delivers the SMS body as `EXTRA_TEXT` -> `text`; `url` is usually empty on Android and a URL inside the text is **not** split out. App must be installed (WebAPK); manifest changes reach an installed app only after Chrome's WebAPK update cycle (up to ~24 h). A share into an already-open PWA navigates the existing task. Service worker: a GET share is a normal navigation; our cache-first `index.html` with `ignoreSearch` is sufficient (never redirect it). iOS Safari: not supported.
- **`launch_handler`**: desktop-only (Chrome 110+); `["navigate-existing","auto"]` is harmless on Android.
- **Badging API**: **not supported on Chrome for Android** (caniuse/MDN, as of Chrome 152). Supported on desktop Chrome/Edge (installed) and iOS 16.4+ (needs notification permission). Android draws its own launcher dot for unread notifications — hence Feature A.
- **Periodic Background Sync**: Chrome (installed PWAs only), `registration.periodicSync.register(tag, { minInterval })`, fired as `periodicsync` in the SW; frequency governed by site-engagement, usually <= twice a day. Not in Firefox/Safari.
- **Amount input**: `inputmode="decimal"`/`"numeric"` keypads on Android expose no `+ - * /`; finance apps ship their own operator row or full keypad. Keep `type="text" inputmode="decimal"`, never `type="number"`.

### 6.2 Pakistani bank / wallet SMS
- **Sourcing caveat**: verbatim bank SMS bodies are almost absent from the open web; bank FAQ pages describe alert *events* but publish no templates; the only PK-specific open-source parser (huzvfa/KHATA) admits it had no real Meezan sample. The only sourced fragments are Easypaisa ("You have sent Rs 500 to 03458501830", "Received Rs 500 from …", "The fee for this transaction is Rs. 10. Your new easypaisa account balance is Rs. 9,000.00", 11-digit Trx ID) and a JazzCash 12-digit TID. **All other fixture messages are reconstructed from those conventions.** The user should collect 20–30 real SMS from their own phone before trusting per-bank wording; the `note` prefill exists so mis-reads are visible and reportable.
- Structure (high confidence): `[verb] [amount] [counterparty] [fee?] [balance] [ref] [date]`; amount always before balance; currency token `Rs|Rs.|PKR|RS`, optional thousands commas, optional `.00`, optional trailing `/-`.
- Balance introducers by frequency: `Avl Bal`, `Available Balance`, `Bal`, `Balance`, `new balance`, `new easypaisa account balance`, `Remaining Balance`, `A/C Bal`, `Cur Bal`.
- Wallets self-name in the body; **traditional banks often do not** (identity only in the sender ID, which the share sheet drops). Provider must be nullable.
- Masking styles: `03xx-xxxxx12`, `03**-***1234`, `****1234`, `XXXX1234`, `A/C ***456`. Refs: `TID` (JazzCash, 12 digits), `Trx ID` (Easypaisa, 11 digits), `Ref No`, `RRN` (12), `STAN`, `Auth Code`.
- Dates when present: `DD-MM-YY`, `DD/MM/YYYY`, `DD-MMM-YY`, sometimes `on … at HH:MM`. Many alerts omit the date.
- Reject before parsing: reversal/failed/declined; OTP; anything with no direction verb.

### 6.3 SMS fixture (expected parse; wording reconstructed except #1–#2)

| # | Message | dir | amount | counterparty | providerKind | balance |
|---|---|---|---|---|---|---|
| 1 | `You have sent Rs 500 to 03458501830. The fee for this transaction is Rs. 10. Your new easypaisa account balance is Rs. 9,000.00. Trx ID 25434512345` | debit | 500 | 03458501830 | easypaisa | 9000 |
| 2 | `Received Rs 500 from 03458554311. Trx ID 25434512399. Your new easypaisa account balance is Rs. 9,500.00` | credit | 500 | 03458554311 | easypaisa | 9500 |
| 3 | `Dear Customer, Rs. 2,500 has been debited from your JazzCash account for payment to K-Electric. TID 715245330780. Available Balance Rs. 7,320.50` | debit | 2500 | K-Electric | jazzcash | 7320.5 |
| 4 | `You have received Rs 15,000 in your JazzCash account from 0300-1234567. TID 715245330999. Balance: Rs 22,320.50` | credit | 15000 | 0300-1234567 | jazzcash | 22320.5 |
| 5 | `Your NayaPay account has been debited PKR 1,250.00 for a card purchase at CAREEM PK. Available balance PKR 8,750.00` | debit | 1250 | CAREEM | nayapay | 8750 |
| 6 | `You received PKR 5,000.00 from AHMED KHAN via Raast in your NayaPay account. Available balance PKR 13,750.00` | credit | 5000 | AHMED KHAN | nayapay | 13750 |
| 7 | `Your SadaPay card ending 1234 was used for PKR 1,250 at FOODPANDA. Remaining Balance PKR 4,310` | debit | 1250 | FOODPANDA | sadapay | 4310 |
| 8 | `PKR 50,000 has been credited to your SadaPay account. Salary. Available balance PKR 54,310` | credit | 50000 | null (title "Salary" via keyword) | sadapay | 54310 |
| 9 | `Your Meezan account ****4567 has been debited with PKR 3,000.00 on 16-09-2026 for ATM withdrawal. Avl Bal PKR 41,200.00` | debit | 3000 | ATM withdrawal | meezan | 41200 (date 2026-09-16) |
| 10 | `Acct ****4567 Credit Rs. 120,000.00 on 01-09-26 Salary. Avl Bal Rs. 161,200.00` | credit | 120000 | null ("Salary") | **null** | 161200 (date 2026-09-01) |
| 11 | `Dear Customer, your UBL account XXXX8901 has been debited with PKR 10,000.00 via IBFT to MUHAMMAD ALI. Ref No 123456789012. Avl Bal PKR 25,600.00` | debit | 10000 | MUHAMMAD ALI | ubl | 25600 |
| 12 | `HBL: Rs 1,499/- spent on your HBL DebitCard ending 4321 at DARAZ PK on 16/09/2026 14:32. Avl Bal Rs 18,220/-` | debit | 1499 | DARAZ | hbl | 18220 (Shopping) |
| 13 | `Your account has been credited with PKR 7,500.00 through Raast from ZAINAB S. Avl Bal PKR 25,720.00` | credit | 7500 | ZAINAB S | **null** | 25720 |
| 14 | `Bank Alfalah: PKR 2,000.00 withdrawn from A/C ***456 at ATM GULBERG LAHORE on 15-09-26. Available Balance PKR 12,400.00` | debit | 2000 | ATM GULBERG LAHORE | alfalah | 12400 |
| 15 | `MCB: Your bill payment of Rs. 3,420/- to SNGPL has been processed from account ****7788. Balance Rs. 9,180/-` | debit | 3420 | SNGPL | mcb | 9180 (Bills) |
| 16 | `Allied Bank: Cash deposit of PKR 25,000.00 credited to your account ****2233 on 14/09/2026. Avl Bal PKR 34,180.00` | credit | 25000 | null ("Cash deposit") | allied | 34180 |
| 17 | `Standard Chartered: Your card ending 9876 was used for PKR 899.00 at NETFLIX.COM. Fee Rs 0. Avl Bal PKR 60,101.00` | debit | **899** (not 0) | NETFLIX.COM | scb | 60101 (Bills) |
| 18 | `Faysal Bank: Transfer of Rs 4,000 to AYESHA NOOR (A/C ****5566) completed. Trx ID FB2609160001. Remaining Balance Rs 1,200` | debit | 4000 | AYESHA NOOR | faysal | 1200 |
| N1 | `Your OTP for transaction of Rs 5,000 is 483920. Do not share.` | rejected `otp` | | | | |
| N2 | `Your transaction of Rs 2,000 has been reversed and credited back.` | rejected `reversal` | | | | |

Counterparty comparisons in the fixture are case-insensitive and ignore a trailing ` PK`. Where the table says `null (…)` the parser returns `counterparty: null` and the title falls back as described in §4.2.

### 6.4 Sources
- MDN `share_target`: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target
- Chrome, Web Share Target: https://developer.chrome.com/docs/capabilities/web-apis/web-share-target
- W3C Web Share Target: https://w3c.github.io/web-share-target/
- Chrome, launch_handler (desktop only): https://developer.chrome.com/docs/web-platform/launch-handler/ and https://groups.google.com/a/chromium.org/g/blink-dev/c/hzR6LNu4JFk
- MDN Badging how-to: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Display_badge_on_app_icon ; caniuse: https://caniuse.com/mdn-api_navigator_setappbadge ; Chrome: https://developer.chrome.com/docs/capabilities/web-apis/badging-api
- MDN inputmode: https://developer.mozilla.org/docs/Web/HTML/Reference/Global_attributes/inputmode
- KHATA (Meezan SMS parser, reconstructed patterns): https://github.com/huzvfa/KHATA
- Easypaisa wording fragments: https://udhaar.pk/how-to-use-easy-paisa-money-transfer-to-send-receive-money/ (410 now; snippet), https://apna4g.com/check-easypaisa-transaction-id/
- Bank alert pages with no templates (checked): https://www.hbl.com/hblbankingalerts , https://www.mcb.com.pk/self-service-channels/sms-alert

## 7. Implementation order

1. `js/util/expr.js` + fixture; wire into `parseAmount`, hint, operator row.
2. Reminders: `dueSchedule` in ledger, `js/reminders.js`, `sw.js` periodicsync + notificationclick + IDB read, Settings group; fixtures.
3. Backup nudge: `sync.js` stamp, `nudge.js`, banner, Settings row value; fixture for `shouldNudgeBackup`.
4. Limits: ledger state + `limitStatus`, Settings rows, Reports line + insights, Home card, CSS.
5. Share target: manifest, `smsparse.js` + fixture from §6, `app.js` boot hook, form prefill + memory.
6. `sw.js` bump + precache; spec/README.
7. Verify (§8).

## 8. Verification (required before reporting done)

- `node --check` on every changed/new `.js` file.
- Node fixtures in the scratchpad (never in the repo): `expr`, `dueSchedule` + `dueSummary`, `shouldNudgeBackup`, `smsparse` (all 18 messages + 2 negatives from §6 with expected results; report the pass count).
- Headless smoke with Playwright's `chromium_headless_shell-1243` (`npm i playwright-core` in the scratchpad; serve the repo with `python -m http.server 8000`). Onboard with PIN 1234 + "Not now" for fingerprint, add two accounts (JazzCash, HBL) and a few entries, then:
  1. Amount field: type `120+80`, hint shows `= Rs 200`, blur -> `200`; submit `1500/3` -> entry of 500. Screenshot.
  2. Reminders: grant notification permission for the origin via the Playwright context (`permissions: ["notifications"]`); stub `ServiceWorkerRegistration.prototype.periodicSync` if absent in headless (`addInitScript`) so the Settings row shows `On` after enabling (headless is not "installed" — also stub `matchMedia("(display-mode: standalone)")` to match, or expose a test hook; say which). Verify: meta `remindersOn === true`, meta `dueSchedule` present with the right `{date,count}` rows after adding an overdue and a due-today expense, `Send a test reminder` calls `showNotification` (spy via `addInitScript` on `ServiceWorkerRegistration.prototype.showNotification`), turning off deletes `dueSchedule`. Run the SW's `checkDue()` logic once in Node as a pure function by extracting `dueSummary` into the fixture (copy the function body; assert the two copies are textually identical with a small script, since the SW cannot import it).
  3. Nudge: seed 10 entries, no sync, no export -> banner visible; click `Later` -> gone and stays gone after reload; set `backupNudgeSnoozedUntil` to the past and `lastExportAt` to 40 days ago -> banner returns; click `Export` -> banner gone, Settings Export row shows today's date. Screenshot.
  4. Limits: set Food = 6000 in Settings; add Food expenses totalling 5100 -> Reports row shows `Rs 5,100 of 6,000` in warn colour; Home shows the limits card; add 1000 more -> `Rs 100 over` in neg colour and a "Worth watching" line. Remove the limit -> Home card disappears. Screenshots at 390×844.
  5. Share target: `page.goto("http://localhost:8000/?text=" + encodeURIComponent(sms))` for (a) a JazzCash debit -> Add Expense sheet with amount/title/JazzCash account selected, and `location.search === ""`; (b) an HBL credit -> Add Money sheet; (c) text with no amount -> expense sheet + toast. Save (a) and verify the entry and that `shareAccountMemory.jazzcash` was written. Screenshot of (a).
  6. Plain boot (no query) -> Home with no sheet.
  If anything cannot be automated, say exactly what and what was verified instead.

## 9. Acceptance checklist

- No `eval`/`Function` anywhere; expression evaluator is fixture-tested.
- Boot without a share payload is byte-for-byte the same flow as today.
- `history.replaceState` strips the share query before unlock.
- Blob/backup/sync formats unchanged (limits live in meta, like categories).
- Reminders, nudge and limits each degrade to nothing when unsupported / unset; the SW never touches the encrypted blob and only ever reads `dueSchedule`, `remindLastDay`, `remindersOn`.
- `sw.js` bumped to v18 with all new files precached; `node --check` clean; fixtures and smoke reported with counts and screenshots.
