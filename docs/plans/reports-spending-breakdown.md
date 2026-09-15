# Reports: Spending Breakdown tabs + Spending Patterns + "Worth watching"

Status: approved plan, ready to implement. Branch: `develop`. Do not commit; leave changes in the working tree for review.

## 0. Context (what exists today)

- Plain ES-module PWA, no build step, no npm, no tests. Files: `js/ui/reports.js` (135 lines), `js/ledger.js`, `js/ui/charts.js`, `js/util/format.js`, `js/util/dom.js`, `css/components.css` (Reports block starts at the `/* === Reports === */` comment), `sw.js` (precache list + `CACHE = "batwa-v14"`).
- Reports page today: month nav -> 3 tiles (in / out / net) -> `#insights` (max 2 lines) -> **Spending by category** (donut + ranked bar list, all categories) -> 6-month trend -> Fixed vs one-off.
- `monthSummary(ym)` returns `{ income, spent, net, byCat, recurringOut, onceOut, list }`. "Spent" = paid expenses only, transfers excluded. `entriesForMonth(ym)` buckets an expense by `dueDate || paidAt || createdAt`.
- Entry fields available for analysis: `title, amount, category, recurrence, dueDate, status, paidAt, createdAt, seriesId, accountId, isAdjustment, note`.
- Reusable UI: `.segmented` (tab strip CSS, 46px buttons, `role=tablist`), the `segmented()` helper currently private in `js/ui/modals.js`, `.cat-row` bar list, `.insight` callout, `.hist-row` list rows, `.filter-chip`, `emptyCard()` in reports.js, `anim()` + `animateCharts()` for motion, `catIcon()` / `icon()` from `js/ui/icons.js`, `accountName()` from `js/ui/accounts.js`, `addExpenseSheet(entry)` from modals for editing an entry.
- Title normalisation precedent: `recentTitles()` in modals.js keys by `title.trim().toLowerCase()`.

### Data caveats that shape the algorithms
- **Spend date** = `(e.dueDate || e.paidAt || e.createdAt).slice(0,10)`. Use this everywhere (same key as `entriesForMonth`) so numbers agree with the tiles.
- **Do not use hour-of-day.** `paidAt` is when the user tapped "Mark paid", not when they spent. Any time-of-day insight would be wrong.
- **`isAdjustment` "Balance fix" expenses** count in `spent` (they are real money gone). Keep them in totals so tiles and breakdown agree, but flag them and surface a dedicated insight when they are a meaningful share.
- Month may be the **current, partial** month. Every per-day metric divides by *days elapsed*, not days in month.
- Weekend = Saturday + Sunday.

## 1. Deliverable, as the user will see it

Replace the "Spending by category" section with one **Spending breakdown** card that has a tab strip:

```
+ Spending breakdown ------------------------------+
| [ Category ] [ Title ]          <- .segmented    |
|                                                  |
| (Category tab = today's donut + ranked list)     |
|                                                  |
| (Title tab)                                      |
|  1  Hostel fees        Rs 12,000   31%           |
|     monthly - Rent/Hostel            #######     |
|  2  Groceries  4x      Rs 6,400    17%           |
|     Food - avg Rs 1,600              ####        |
|  3  Fuel  6x           Rs 4,200    11%           |
|  4  Chai  18x          Rs 2,700     7%           |
|  5  Internet           Rs 2,500     6%           |
|  [ Show 9 more ]                                 |
+--------------------------------------------------+

+ Spending patterns -------------------------------+
|  Mon Tue Wed Thu Fri Sat Sun   (7 mini bars,     |
|   .   .   .   .   :   #   #    top day lit)      |
|  "Weekends cost you 42% more per day."           |
|                                                  |
|  Early 1-10 ###### 58%   Mid ## 22%   Late ## 20%|
|  "More than half your month goes in the first    |
|   10 days."                                      |
|                                                  |
|  [ Daily avg ] [ Priciest day ] [ No-spend ]     |
|  [ Rs 1,240  ] [ 14 Sep 9.4k  ] [ 9 days   ]     |
|  (current month only) "At this pace: Rs 37k      |
|   by month end, vs Rs 31k last month."           |
+--------------------------------------------------+

+ Worth watching ------------------------------ ! -+
| * Three things are 59% of your month: Hostel     |
|   fees, Groceries, Fuel. These decide the        |
|   month, so plan them first.                     |
| * Chai, 18 times. Small each time, Rs 2,700      |
|   together.                                      |
| * Groceries is up Rs 1,800 (+39%) vs August.     |
+--------------------------------------------------+
```

Then the existing 6-month trend and Fixed vs one-off follow unchanged.

Tone: factual, calm, second person, never scolding. Each caution line states the fact, then at most one short nudge. Amounts use `fmtMoney` in sentences and `fmtCompact` in tiles/rows.

## 2. Architecture

### 2.1 New pure module: `js/insights.js`
- **No DOM, no imports from `util/dom.js`** (it calls `matchMedia` at load). Import only from `util/format.js` (`isoDate`, `parseDay`, `shiftMonth`). Must run under plain Node so it can be smoke-tested with a fixture.
- Signature: `analyzeMonth(entries, ym, { today = isoDate() } = {})`. `entries` is the full ledger array (`state.entries`); the function filters to paid, non-transfer expenses whose spend date is in `ym`.
- Returns structured facts only; no strings for the UI. Shape:

```js
{
  ym, spent, count, daysInMonth, daysElapsed, isCurrent,
  titles: [{ key, title, category, recurrence, isAdjustment, total, count, avg, share, entries }], // desc by total
  largest: { entry, share } | null,                        // single biggest paid expense
  concentration: { topN: 3, share, titles: [...] } | null, // share of spent held by top 3 titles
  habits: [{ key, title, count, total, avg, share }],      // count >= 4, sorted by count desc
  weekday: {                                               // index 0 = Mon ... 6 = Sun
    totals: number[7], counts: number[7], daysElapsed: number[7], perDay: number[7],
    topIndex, weekendPerDay, weekdayPerDay, ratio          // ratio = weekendPerDay / weekdayPerDay (null if either side has 0 elapsed days)
  },
  phase: { early, mid, late, shares: { early, mid, late } }, // day 1-10, 11-20, 21-end
  daily: { avg, median, spendDays, noSpendDays, peak: { date, total, entries } | null },
  projection: { projected, prevSpent } | null,             // current month only
  deltas: { risers: [{ key, title, cur, prev, diff, pct }], newcomers: [{ key, title, total }] },
  adjustments: { total, share, count },
}
```

- Title grouping: `key = title.trim().replace(/\s+/g, " ").toLowerCase()`; empty -> `"untitled"`. Display title = the most recent entry's original casing. `category` / `recurrence` = from the most recent entry in the group.
- `daysElapsed` = `today` day-of-month when `ym === today.slice(0,7)`, else `daysInMonth`. `isCurrent` = that same check. If `ym` is in the future (should not happen; next button is disabled) treat as 0 elapsed and return empty-safe values.
- `weekday.daysElapsed[i]` = how many of weekday `i` have occurred in the month up to `daysElapsed`. `perDay[i] = totals[i] / daysElapsed[i]` (0 when none elapsed).
- `daily.median` = median of per-day totals over days that had spending. `noSpendDays = daysElapsed - spendDays`.
- `projection.projected = daily.avg * daysInMonth`; `prevSpent` = spent of previous month (compute via a second internal pass over entries for `shiftMonth(ym, -1)`, do not import ledger.js).
- `deltas`: compare title totals to previous month. `risers` = present in both, `diff > 0`, `pct >= 20`, and `diff >= 0.05 * spent`. `newcomers` = titles in this month not present in any of the previous 3 months, sorted by total desc.
- All divisions guard zero. Every array exists even when empty.

### 2.2 Insight text generation stays in `js/ui/reports.js`
A single `buildInsights(analysis, sum, prev)` returns `[{ id, tone: "good" | "info" | "caution", weight, html }]`. The existing three insight lines move into it (tone info/good). Rendering:
- Top `#insights` block: top 2 by weight among tone `good` / `info` (keeps today's behaviour).
- "Worth watching" card: top 3 by weight among tone `caution`. Card hidden entirely when there are none.
No insight appears in both places.

### 2.3 Confidence gates (this is what makes it feel like a real report, not a random sentence)
Only emit an insight when its gate passes. Weights order the list; higher shows first.

| id | tone | gate | text template | weight |
|---|---|---|---|---|
| `top-category` | info | any spend | (existing) "**Food** was your biggest category this month at **Rs 8,400**." | 50 |
| `vs-last-month` | good/info | (existing) `abs(diff) > 10% prev` | (existing) | 60 |
| `recurring-baseline` | info | (existing) recurring >= 40% | (existing) | 40 |
| `concentration` | caution | >= 5 distinct titles and top-3 share >= 50% | "Three things are **59%** of your month: **Hostel fees**, **Groceries**, **Fuel**. These decide the month, so plan them first." (render the three as pills under the line) | 90 |
| `largest-single` | caution | only when `concentration` did NOT fire; largest share >= 25% and count >= 3 | "One payment, **Hostel fees, Rs 12,000**, was **31%** of everything you spent." | 80 |
| `habit` | caution | top habit count >= 4 and its total >= 5% of spent | "**Chai**, **18 times**. Small each time, **Rs 2,700** together." | 70 |
| `weekend` | caution | count >= 8, at least 2 Saturdays and 2 Sundays elapsed, ratio >= 1.25 | "Weekends cost you **42%** more per day than weekdays." | 75 |
| `weekday-peak` | info | `weekend` did not fire; count >= 8; `perDay[top] >= 1.5 * mean(perDay)` | "**Fridays** are your most expensive day, about **Rs 2,100** each." | 30 |
| `front-loaded` | info | daysElapsed >= 20 and early share >= 50% | "More than half your month (**58%**) goes in the first 10 days." | 35 |
| `back-loaded` | caution | daysElapsed >= 25 and late share >= 45% | "**45%** of your spending landed in the last 10 days. The month got expensive at the end." | 45 |
| `pace` | caution if `projected > prevSpent * 1.1`, else info | current month, daysElapsed >= 5, prevSpent > 0 | "At this pace you'll end at about **Rs 37,000**, vs **Rs 31,000** last month." | 65 caution / 25 info |
| `peak-day` | info | spendDays >= 3 and peak.total >= 2 * daily.avg and peak.total >= 15% of spent | "**14 Sep** was your priciest day: **Rs 9,400** across 3 payments." | 20 |
| `riser` | caution | first of `deltas.risers` | "**Groceries** is up **Rs 1,800** (+39%) vs August." | 55 |
| `newcomer` | info | first newcomer with total >= 10% of spent | "**Bike repair** is new this month: **Rs 4,500** you didn't have in the last few months." | 15 |
| `adjustments` | caution | adjustments.share >= 15% and total > 0 | "**Rs 3,000** of this month is balance fixes, money you couldn't trace. Logging as you go keeps this number small." | 85 |
| `no-spend` | good | daysElapsed >= 10, noSpendDays >= 30% of daysElapsed | "**9 no-spend days** this month. Nice." | 20 |

Month names in text come from `monthLabel(shiftMonth(ym, -1)).split(" ")[0]`.

### 2.4 `js/ui/reports.js` changes
- Module state: add `let breakdownTab = "category"` and `let titlesExpanded = false` next to `currentMonth`. Tab survives month navigation; `titlesExpanded` resets on month change.
- Page skeleton: replace the category `section-head` + `#cat-chart` with:
  ```html
  <div class="section-head"><h2>Spending breakdown</h2></div>
  <div class="card chart-card" id="breakdown">
    <div id="bd-tabs"></div>
    <div id="bd-panel" role="tabpanel"></div>
  </div>
  <div class="section-head"><h2>Spending patterns</h2></div>
  <div class="card chart-card" id="patterns"></div>
  <div id="watch"></div>   <!-- Worth watching card; empty when nothing qualifies -->
  ```
  then trend and split as before.
- `renderBreakdown(root, sum, analysis)`: builds the tab strip with the shared `segmented()` helper (see 2.6) with options `[{value:"category",label:"Category"},{value:"title",label:"Title"}]`. Switching a tab repaints **only** `#bd-panel` with a short fade (`anim(panel, {opacity:0,y:6}, {opacity:1,y:0,duration:.22})`) and re-runs `animateCharts(panel)`. Never re-render the page on tab switch.
- Category panel = existing `renderCatChart` body, unchanged visually.
- Title panel = `renderTitlePanel(panel, analysis)`:
  - Empty state: `emptyCard("No paid expenses this month yet.")`.
  - Rows: new `.title-row` (see CSS). Left: rank badge (1-3 get the violet gradient, rest muted). Middle: title (truncate) with `xN` count pill when count > 1; meta line `category - monthly` or `category - avg Rs 1,600` when count > 1; adjustment rows get the `scale` icon + "adjustment" like history does. Right: `fmtCompact(total)` + share `%`. Under the middle: bar track with width = share % (use `.cat-bar` classes so `animateCharts` animates it; colour = `CHART_COLORS[i % 10]` for the top 5, `var(--c-faint)` for the rest).
  - Show first 5. If more: a full-width `btn btn-ghost btn-sm` "Show N more" (`aria-expanded`) that appends the remaining rows with a stagger and turns into "Show less". Uses `titlesExpanded`.
  - Tap a row -> toggles an inline detail list under it (`.title-detail`): one line per entry: `shortDate(spendDate) - accountName || ''` left, amount right; tapping a detail line opens `addExpenseSheet(entry)`. Only one row expanded at a time. `aria-expanded` on the row button.
- `renderPatterns(root, analysis)`:
  - Empty: `emptyCard("Patterns show up once there are a few paid expenses.", "bar-chart")` when `count < 3`.
  - Weekday chart: new `weekdayBars(perDay, topIndex)` in `charts.js` (7 rounded bars, labels M T W T F S S, top bar in `#6248F5`, others `#D9D3FA`, weekend bars slightly darker `#B49AFF` when not top). Caption below: the `weekend` insight text if its gate passes, else `weekday-peak` text if it passes, else "Spending is spread fairly evenly across the week." (only when count >= 8; below that, caption "Not enough days yet to see a weekly pattern.").
  - Phase strip: new `phaseBar({early, mid, late})` in `charts.js`: one stacked rounded bar like `splitBar` (three segments, violet / aqua / mint) with a legend "1-10 - 58%  11-20 - 22%  21-30 - 20%". Caption: front-/back-loaded text when gated, else nothing.
  - Stat tiles: a 3-up `.stat-row` of `.stat` mini tiles: "Daily avg" `fmtCompact(daily.avg)` with sub "over N days"; "Priciest day" `shortDate(peak.date)` with sub `fmtCompact(peak.total)`; "No-spend days" `noSpendDays` with sub "of N". On phones the three fit in one row at 320px (see CSS).
  - Pace line (current month only, when `projection` exists): a `.pace` row with a clock icon and the `pace` text.
- `renderWatch(root, insights)`: card `.watch-card` with header "Worth watching" + `alert` icon, then up to 3 `.watch-line` items; each has a small bullet dot and the html. The `concentration` line renders its three titles as pills. Hidden when no caution insights.
- Desktop (>= 900px): wrap the page in `.reports-grid`: left column = tiles, insights, breakdown; right column = patterns, watch, trend, split. Two columns `minmax(0,1fr) minmax(0,1fr)`, gap `var(--s-6)`, `align-items:start`. Below 900px it is a normal stack (grid with one column), so the DOM order is identical on both.

### 2.5 `js/ui/charts.js` additions
- `weekdayBars(perDay, topIndex, { height = 120 })` -> SVG, `viewBox 0 0 340 H`, bars class `bar-anim` so `animateCharts` picks them up, labels under bars, exact per-day value as `<title>` on each bar.
- `phaseBar({ early, mid, late })` -> element built like `splitBar` (three segments, `div.bar-anim`), legend with the three shares.
- Export both.

### 2.6 Shared `segmented()` helper
Move `segmented(options, active, onPick)` from `js/ui/modals.js` to `js/util/dom.js` (it only needs `el` and `buzz`, both already there), export it, and import it back into modals.js. Add roving `tabindex` + Left/Right arrow key handling inside it (small, benefits the quick-add sheet too). Behaviour of existing callers must not change.

### 2.7 CSS (`css/components.css`, Reports block)
Add, using tokens only:
- `.bd-tabs { margin-bottom: var(--s-4); }`
- `.title-row` (button, full width, text-align left, grid `auto 1fr auto`, gap `var(--s-3)`, padding `10px 0`, border-top between rows, min-height 56px, `:active` background `var(--c-surface-2)`), `.title-rank` (26px circle, `.is-top` variant with `var(--grad-action)` + white), `.title-name`, `.title-count` (tiny pill like `.badge`), `.title-meta` (xsmall muted), `.title-amt` (num, 800), `.title-pct` (xsmall muted right), reuse `.cat-bar-track` + `.cat-bar` classes for the bar.
- `.title-detail` (indented list, border-left 2px `var(--c-border-strong)`, rows 40px min, `.title-detail-row:active` feedback), `.title-more` (full-width ghost button, margin-top `var(--s-3)`).
- `.stat-row { display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: var(--s-2); margin-top: var(--s-4); }`, `.stat { background: var(--c-surface-2); border:1px solid var(--c-border); border-radius: var(--r-md); padding: 10px 8px; text-align:center; }`, `.stat-v` (fs-md 800, num), `.stat-l` (xsmall muted uppercase 0.06em), `.stat-s` (xsmall muted). At 320px the values must not overflow: `.stat-v { font-size: clamp(0.95rem, 4.2vw, var(--fs-md)); }`.
- `.pattern-cap` (small, ink-soft, margin-top `var(--s-2)`), `.pattern-block + .pattern-block { margin-top: var(--s-5); padding-top: var(--s-5); border-top: 1px solid var(--c-border); }`
- `.pace` (row, gap s-2, small, `var(--c-warn)` when `.is-over`)
- `.watch-card` (card padding s-5, border `1px solid rgba(232,147,12,0.28)`, background `linear-gradient(135deg, rgba(232,147,12,0.08), rgba(239,70,103,0.05))`), `.watch-head` (row, gap s-2, fs-sm 700, `var(--c-warn)`), `.watch-line` (flex, gap s-3, small, ink-soft, padding 8px 0, bullet `::before` 6px dot `var(--c-warn)` at 0.6em), `.watch-pills` (wrap, gap 6px, margin-top 6px; pills reuse `.badge.badge-cat`).
- `.reports-grid` per 2.4 with the `@media (min-width: 900px)` two-column rule.
- Every tappable thing >= 44px tall. `prefers-reduced-motion` is already handled globally by `anim()`.

### 2.8 Service worker + docs
- `sw.js`: add `"./js/insights.js"` to `SHELL`; bump `CACHE` to `"batwa-v15"`.
- `README.md` "The four tabs" table, Reports row: "Month summary, spending breakdown by category or title, spending patterns (weekday, month phase, daily pace), worth-watching callouts, 6-month trend, fixed vs one-off".

## 3. Implementation order
1. `js/insights.js` (pure). Write a throwaway Node fixture script in the scratchpad (not in the repo) that imports it with ~30 synthetic entries spanning weekdays/weekends, repeated titles, one adjustment, a previous month, and asserts: shares sum to ~100, weekend ratio > 1 for weekend-heavy data, `daysElapsed` respects `today`, `projection` null for a past month, deltas pick up a riser. Run with `node`.
2. Move + export `segmented()` (2.6); confirm modals still import it.
3. `charts.js` additions.
4. `reports.js`: skeleton, breakdown tabs, title panel, patterns, watch card, insights engine.
5. CSS.
6. `sw.js` + README.
7. `node --check` every changed `.js` file. Serve with `python -m http.server 8000` (or `npx serve`) from the repo root and load `http://localhost:8000` in a browser if one can be driven from this environment; otherwise state clearly that the browser pass was not done.

## 4. Acceptance checklist
- Reports opens on the Category tab and looks the same as before in that tab.
- Title tab: top 5 by total, `xN` counts, share %, bars; "Show N more" reveals the rest and flips to "Show less"; row tap expands its transactions; tapping a transaction opens the edit sheet; the tab choice survives switching months.
- Patterns card: weekday bars with top day highlighted; phase bar; three stat tiles readable at 320px; pace line only in the current month.
- "Worth watching" appears only when at least one caution gate passes, max 3 lines, no line duplicated in the top insights.
- Empty month: every card shows an empty state, no exceptions in the console.
- Month with 1-2 expenses: no pattern claims (gates hold), breakdown still lists them.
- No horizontal scroll at 320px; two columns at >= 900px.
- Keyboard: tabs reachable, arrow keys move between them, show-more and rows are buttons.
- `node --check` passes on all changed files; the fixture script passes; `sw.js` cache bumped and new file precached.
- Nothing committed.
