# Claymorphism restyle (restrained)

Status: approved plan, ready to implement. Branch: `develop`. Do not commit; leave changes in the working tree for review.

## 0. Goal and taste rules

Give Batwa a soft "molded clay" feel without turning it into a toy. The user's exact words: *beautiful, not congested and ugly*. Everything below is CSS only. No markup changes, no JS changes except the `sw.js` cache bump.

Research-backed rules that shape every decision here (sources: Malewicz/UX Collective, Smashing Magazine 2022, setproduct.com claymorphism guide, superdesign.dev):

1. **Full 3-layer clay only on things you press.** Static containers get a much quieter "soft raise" (outer shadow + hairline top highlight). If everything is puffy, nothing is.
2. **Max two clay levels deep.** A soft card may contain full-clay buttons. Nothing inside a card gets its own card-level clay (`.stat`, `.acc-logo`, list rows stay flat).
3. **One saturated call to action per screen.** Already true in Batwa (primary button / FAB). Do not add violet fills anywhere new.
4. **Tint every shadow with the surface hue.** Never pure black in light mode, never pure white highlights in dark mode.
5. **Dark mode is recalibrated, not inverted.** Outer shadow goes near-black and tight; the top-left highlight becomes the main depth cue and is tinted from `#9B85FF` at low alpha.
6. **Animate only `transform`.** Shadow states swap instantly (`box-shadow` is repaint-heavy on mobile). Respect `prefers-reduced-motion`.
7. **Typography stays.** Outfit is a named good fit for clay. Keep 500/600/700 steps. `.btn` is already 700 with `0.01em` tracking. No new typeface, no size changes.
8. **Colours stay.** The violet palette already has the pastel tints clay needs. Only shadow tokens change.

## 1. New tokens (`css/tokens.css`)

Add after the existing `--shadow-*` block in `:root`, and a recalibrated set in `:root[data-theme="dark"]`. Keep the existing `--shadow-*` tokens untouched (sheet, toast, tip, install banner, drag row still use them).

```css
/* ---- Clay (light) ----
   hi = inner highlight (top-left), lo = inner shade (bottom-right).
   Interactive = full stack. Surface = quiet raise. Sunken = wells/tracks. */
--clay-hi:  rgba(255, 255, 255, 0.85);
--clay-lo:  rgba(98, 72, 245, 0.10);
--clay-drop: 0 12px 28px -12px rgba(98, 72, 245, 0.22);

/* static cards / tiles — quiet */
--clay-surface:
  inset 0 1.5px 0 var(--clay-hi),
  inset 0 -2px 0 var(--clay-lo),
  0 1px 2px rgba(23, 19, 58, 0.04),
  var(--clay-drop);

/* neutral pressables on a surface: ghost btn, icon-btn, chips, segmented thumb */
--clay-soft:
  inset 2px 2px 6px rgba(255, 255, 255, 0.95),
  inset -2px -3px 6px rgba(98, 72, 245, 0.10),
  0 6px 14px -6px rgba(98, 72, 245, 0.25);
--clay-soft-press:
  inset 2px 3px 8px rgba(98, 72, 245, 0.16),
  inset -1px -1px 3px rgba(255, 255, 255, 0.6),
  0 1px 3px -1px rgba(98, 72, 245, 0.15);

/* coloured gradient pressables: primary / mint / danger / FAB.
   Insets are neutral white/ink alpha so one token works on any gradient;
   the coloured glow is a separate per-variant token. */
--clay-ink-hi: rgba(255, 255, 255, 0.34);
--clay-ink-lo: rgba(12, 4, 60, 0.26);
--clay-btn:
  inset 3px 3px 8px var(--clay-ink-hi),
  inset -3px -4px 8px var(--clay-ink-lo);
--clay-btn-press:
  inset 3px 4px 10px var(--clay-ink-lo),
  inset -1px -1px 3px rgba(255, 255, 255, 0.14);
--glow-violet: 0 12px 26px -8px rgba(91, 61, 240, 0.55);
--glow-mint:   0 12px 26px -8px rgba(18, 183, 127, 0.50);
--glow-danger: 0 12px 26px -8px rgba(226, 58, 95, 0.50);
--glow-press:  0 3px 8px -4px rgba(23, 19, 58, 0.30);

/* wells: inputs, segmented track, switch track, limit track */
--clay-sunken:
  inset 0 2px 6px rgba(23, 19, 58, 0.08),
  inset 0 -1px 0 rgba(255, 255, 255, 0.9);
--ring-focus: 0 0 0 4px rgba(98, 72, 245, 0.16);
--ring-error: 0 0 0 4px rgba(239, 70, 103, 0.14);
```

Dark theme values (do not reuse light ones):

```css
--clay-hi:  rgba(155, 133, 255, 0.16);
--clay-lo:  rgba(0, 0, 0, 0.30);
--clay-drop: 0 12px 28px -12px rgba(0, 0, 0, 0.55);
--clay-surface:
  inset 0 1px 0 var(--clay-hi),
  inset 0 -2px 0 var(--clay-lo),
  0 1px 2px rgba(0, 0, 0, 0.35),
  var(--clay-drop);
--clay-soft:
  inset 2px 2px 6px rgba(155, 133, 255, 0.14),
  inset -2px -3px 6px rgba(0, 0, 0, 0.35),
  0 6px 14px -6px rgba(0, 0, 0, 0.5);
--clay-soft-press:
  inset 2px 3px 8px rgba(0, 0, 0, 0.45),
  inset -1px -1px 3px rgba(155, 133, 255, 0.10),
  0 1px 3px -1px rgba(0, 0, 0, 0.4);
--clay-ink-hi: rgba(255, 255, 255, 0.22);
--clay-ink-lo: rgba(0, 0, 0, 0.34);
--glow-violet: 0 12px 26px -8px rgba(46, 25, 160, 0.75);
--glow-mint:   0 12px 26px -8px rgba(11, 139, 96, 0.6);
--glow-danger: 0 12px 26px -8px rgba(196, 46, 79, 0.6);
--glow-press:  0 3px 8px -4px rgba(0, 0, 0, 0.6);
--clay-sunken:
  inset 0 2px 6px rgba(0, 0, 0, 0.45),
  inset 0 -1px 0 rgba(155, 133, 255, 0.10);
--ring-focus: 0 0 0 4px rgba(155, 133, 255, 0.22);
--ring-error: 0 0 0 4px rgba(255, 112, 137, 0.20);
```

`--clay-btn` and `--clay-btn-press` are composed from `--clay-ink-*`, so they only need defining once in `:root`.

## 2. Component changes (`css/components.css`)

Line numbers are from the current file; grep the selector if they drift.

### 2.1 Full clay, pressable (coloured)

| Selector | Change |
|---|---|
| `.btn-primary` :619 | `box-shadow: var(--clay-btn), var(--glow-violet);` |
| `.btn-mint` :620 | `box-shadow: var(--clay-btn), var(--glow-mint);` (drops the hard-coded rgba) |
| `.btn-danger` :622 | `box-shadow: var(--clay-btn), var(--glow-danger);` (drops the hard-coded rgba) |
| `.nav-fab` :692-705 | `box-shadow: var(--clay-btn), var(--glow-violet);` keep the 4px surface border. `:active` → `transform: translateY(1px) scale(0.94); box-shadow: var(--clay-btn-press), var(--glow-press);` |
| `.btn:active` :618 | `transform: translateY(1px) scale(0.97);` and add `.btn-primary:active, .btn-mint:active, .btn-danger:active { box-shadow: var(--clay-btn-press), var(--glow-press); }` |
| `.btn` transition :615 | change to `transition: transform var(--t-fast) var(--ease-out), filter var(--t-fast);` (no box-shadow animation) |
| `.btn` radius | bump `.btn` to `18px` (between `--r-md` and `--r-lg`; clay wants a touch more roundness on buttons). `.btn-sm` stays `--r-sm`. |

### 2.2 Light clay, pressable (neutral, on a surface)

| Selector | Change |
|---|---|
| `.btn-ghost` :621 | keep bg + border; add `box-shadow: var(--clay-soft);` `.btn-ghost:active { box-shadow: var(--clay-soft-press); }` |
| `.btn-soft-danger` :623 | `box-shadow: var(--clay-soft);` press → `--clay-soft-press` |
| `.icon-btn` :16-26 | replace `--shadow-xs` with `var(--clay-soft)`; transition transform only; `:active` add `box-shadow: var(--clay-soft-press)` (keep `scale(0.92)`) |
| `.chip-btn` :571-584 | add `box-shadow: var(--clay-soft);` `:active` → `--clay-soft-press` (keep `scale(0.95)`) |
| `.suggest-chip` :834-849 | same as chip-btn |
| `.filter-chip` :1235-1251 | add `box-shadow: var(--clay-soft);` `.is-active` (inverse bg) → `box-shadow: var(--clay-btn), var(--glow-press);` so the dark pill reads as pressed-in clay. Change `transition: all` to `transition: color var(--t-fast), background var(--t-fast), transform var(--t-fast);` |
| `.sync-pill` :36-58 | `--shadow-xs` → `var(--clay-soft)`; `:active` → `--clay-soft-press` |
| `.segmented button.is-active` :897 | `--shadow-xs` → `var(--clay-soft)` |

### 2.3 Soft raise, static

| Selector | Change |
|---|---|
| `.card` :498-503 | `box-shadow: var(--clay-surface);` (all composed cards inherit: chart/exp/set/limits/watch/acc). Keep the 1px border. |
| `.tile` :1178-1184 | `--shadow-xs` → `var(--clay-surface)` |
| `.hero-card` :351-379 | append an inner rim to the existing shadow: `box-shadow: inset 0 1.5px 0 rgba(255,255,255,0.28), inset 0 -3px 0 rgba(12,4,60,0.18), var(--shadow-hero);` These are literals on purpose: the hero sits on the violet gradient in both themes (see the note at :1679-1683). `.hero-card.is-negative` :414 keeps its red glow, prefix the same two insets. |
| `.exp-card.is-overdue` :556 | keep its red-tinted drop, but prefix `inset 0 1.5px 0 var(--clay-hi), inset 0 -2px 0 var(--clay-lo),` so it matches the other cards. |
| `.sheet` :725 | `box-shadow: inset 0 1.5px 0 var(--clay-hi), var(--shadow-sheet);` (hairline lip at the top; nothing else). |

### 2.4 Sunken wells

| Selector | Change |
|---|---|
| `.input`, `select.input`, `textarea.input` :774-794 | add `box-shadow: var(--clay-sunken);` `.input:focus` → `box-shadow: var(--clay-sunken), var(--ring-focus);` (replaces the hard-coded ring at :792). `.field.has-error .input` :874 → `box-shadow: var(--clay-sunken), var(--ring-error);` |
| `.segmented` track :877 | `box-shadow: var(--clay-sunken);` |
| `.switch` :938-958 | track `box-shadow: var(--clay-sunken);` knob `::after` :954 → `box-shadow: var(--clay-soft);` Dark override at :1707 → delete (the token handles it). |
| `.limit-track` :1608-1618 | `border-radius: var(--r-pill); box-shadow: var(--clay-sunken);` height stays. |

### 2.5 Gradient surfaces (lock screen, onboarding). Theme-independent literals.

| Selector | Change |
|---|---|
| `.key` :1057-1070 | add `box-shadow: inset 2px 2px 6px rgba(255,255,255,0.22), inset -2px -3px 6px rgba(12,4,60,0.22), 0 8px 18px -8px rgba(12,4,60,0.35);` `:active` → `box-shadow: inset 2px 3px 8px rgba(12,4,60,0.30), inset -1px -1px 3px rgba(255,255,255,0.10);` keep the bg change and `scale(0.92)`. |
| `.bio-btn` :1089-1101 | same recipe as `.key` (replaces the 1px inset). |
| `.onb-btn` (onboarding.css :102-118) | `box-shadow: inset 3px 3px 8px rgba(255,255,255,0.9), inset -3px -4px 8px rgba(70,48,201,0.18), 0 14px 30px -12px rgba(9,5,40,0.6);` `:active` → `box-shadow: inset 3px 4px 10px rgba(70,48,201,0.22), 0 4px 10px -6px rgba(9,5,40,0.5);` keep `scale(0.97)`. |
| `.lock-offer-btn` :1140-1149 | same as `.onb-btn`. |
| `.pin-dot` :1042-1049 | unfilled: `box-shadow: inset 0 1px 3px rgba(12,4,60,0.35);` `.is-filled`: `box-shadow: 0 2px 6px rgba(12,4,60,0.35);` |

### 2.6 Explicitly left flat (do not touch)

`.bottom-nav`, `.app-header`, `.toast`, `.install-banner`, `.nudge-banner`, `.badge*`, `.cat-pill`, `.stat`, `.warn-card`, `.empty`, `.acc-logo*` (its existing inset is fine at that size), `.insight`, `.tip`, all list rows (`.hist-row`, `.set-row`, `.title-row`, `.cat-row`), `.month-nav`, `.legend`, `.acc-reorder-row`, `.copy-box`. These are either chrome, text, or already nested inside a card. Keeping them flat is what stops the screen from getting congested.

### 2.7 Hover (pointer devices only) and motion

Add once, near the buttons block:

```css
@media (hover: hover) and (pointer: fine) {
  .btn:not([disabled]):hover, .nav-fab:hover, .icon-btn:hover, .chip-btn:hover { transform: translateY(-1px); }
  .btn:not([disabled]):active, .nav-fab:active, .icon-btn:active, .chip-btn:active { transform: translateY(1px) scale(0.97); }
}
```

In `css/base.css` `@media (prefers-reduced-motion: reduce)` add:

```css
.btn:active, .nav-fab:active, .icon-btn:active, .chip-btn:active, .key:active { transform: none; }
```

(Shadow state still swaps instantly; only the squish is removed.)

### 2.8 Dark touch-ups block :1676+

Delete the dark `.switch::after` override at :1707 (now tokenised). Leave everything else in that block.

## 3. `sw.js`

Bump `CACHE = "batwa-v20"` → `"batwa-v21"`. No new files.

## 4. Verification (implementer does all of this, reports results)

1. `node --check sw.js`.
2. Grep sanity: no remaining `0 8px 20px -6px rgba(18,183,127` / `rgba(226,58,95,0.4)` in components.css; no `transition: all` on `.filter-chip`; `--clay-` appears in both `:root` and `:root[data-theme="dark"]`.
3. Headless smoke with Playwright's `chromium_headless_shell-1243` (`%LOCALAPPDATA%\ms-playwright`). `npm i playwright-core` **in the scratchpad dir only**, never in the repo. Serve the repo with `python -m http.server 8000` from the repo root. Viewport **390×844**, `deviceScaleFactor: 2`. Read `js/auth.js` for the onboarding selectors; onboard with PIN `1234`, choose "Not now" for fingerprint, add two accounts and 3 to 4 expenses (one overdue) so Home has a hero, account cards, a limits card and expense cards. Then screenshot, saving to the scratchpad:
   - `home-light.png`, `home-dark.png` (toggle dark via the header sun/moon `.theme-toggle`, or `localStorage["batwa.theme"]="dark"` + reload)
   - `reports-light.png`, `reports-dark.png`
   - `settings-light.png`, `settings-dark.png`
   - `sheet-light.png` (FAB → quick add sheet open, showing inputs, segmented tabs, primary button)
   - `lock-light.png` (reload after onboarding, lock screen with keypad)
   - `press-light.png`: use `page.mouse.down()` on the primary button in the sheet and screenshot while held, to prove the pressed state.
4. In each screenshot check, and state in the report: cards read as softly raised, not puffy; buttons look pressable; inputs look sunken; nothing looks doubled up (clay inside clay); dark mode highlights are violet-tinted, no white glare; text contrast unchanged.
5. Report: list of selectors changed, grep results, screenshot paths, anything you deviated from in this plan and why.

## 5. Done when

All of §1 to §3 applied, §4 checks pass, screenshots delivered, no JS or HTML edits other than `sw.js`, no commit.
