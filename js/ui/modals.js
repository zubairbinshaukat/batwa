// Bottom sheets (mobile) / centered modals (desktop):
// add money, add/edit expense, confirm, and multi-choice sheets.

import { $, el, esc, anim, animTo, trapFocus, motionOK, buzz, segmented } from "../util/dom.js";
import { state, addEntry, updateEntry, deleteEntry, deleteSeriesFuture, restoreEntries, transferMoney, accountBalance, balances } from "../ledger.js";
import { isoDate, fmtMoney, shortDate } from "../util/format.js";
import { CURRENCY } from "../util/format.js";
import { toast } from "./toast.js";
import { logoTile, accountName, addAccountSheet } from "./accounts.js";
import { icon } from "./icons.js";
import { evalAmountExpr, looksLikeExpr } from "../util/expr.js";
import { categoryField } from "./catedit.js";
import { getMeta, setMeta } from "../db.js";

let current = null; // { backdrop, sheet, release, resolveClosed }
let pendingHooks = null; // collects onSheetMounted/onSheetClosed while build() runs

const isDesktop = () => matchMedia("(min-width: 640px)").matches;

export function sheetOpen() { return !!current; }

/** From inside build(): run fn once the sheet is in the DOM, so layout reads are valid. */
export function onSheetMounted(fn) { pendingHooks && pendingHooks.mounted.push(fn); }
/** From inside build(): run fn when the sheet closes — tear down observers here. */
export function onSheetClosed(fn) { pendingHooks && pendingHooks.closed.push(fn); }

/** Open a sheet. `build(body)` fills the content. Returns close(). */
export function openSheet(title, build, { onDismiss } = {}) {
  if (current) closeSheet(true);

  const backdrop = el("div", { class: "sheet-backdrop", onclick: () => closeSheet() });
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title });
  sheet.append(el("div", { class: "sheet-grab", "aria-hidden": "true" }));
  if (title) sheet.append(el("h2", {}, title));
  const body = el("div", {});
  sheet.append(body);

  const hooks = { mounted: [], closed: [] };
  pendingHooks = hooks;
  try { build(body); } finally { pendingHooks = null; }

  const root = $("#sheet-root");
  root.append(backdrop, sheet);
  // In the DOM but not yet painted: anything measured here lands in the first frame.
  for (const fn of hooks.mounted) fn();

  const release = trapFocus(sheet);
  current = { backdrop, sheet, release, onDismiss, closed: hooks.closed };

  // hardware back closes the sheet, not the app
  history.pushState({ batwaSheet: true }, "");

  anim(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.25 });
  if (isDesktop()) {
    // CSS already centres via translate(-50%,-50%). Animating y/yPercent here
    // would stack on top of that and throw the sheet off-screen — scale only.
    anim(sheet, { opacity: 0, scale: 0.92 },
      { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.4)" });
  } else {
    anim(sheet, { yPercent: 100 }, { yPercent: 0, duration: 0.45, ease: "power4.out" });
    wireSwipeToDismiss(sheet, backdrop);
  }

  // Skips inert panes — the quick-add sheet parks its off-screen tabs there,
  // so this lands on the tab you actually opened, not always the first one.
  const first = [...sheet.querySelectorAll("input, select, textarea, button")]
    .find((n) => !n.closest("[inert]"));
  if (first && !("ontouchstart" in window)) setTimeout(() => first.focus(), 80);
  return closeSheet;
}

/**
 * Native-feel swipe-down-to-dismiss for the mobile sheet.
 *
 * Who owns a touch is decided once, from its first 8px of travel, and never
 * revisited:
 *   • The browser owns vertical panning everywhere — the sheet is the scroll
 *     container — so content scrolls on the FIRST swipe, from anywhere.
 *   • This handler claims a gesture only when it is unambiguously a downward
 *     drag the sheet cannot absorb as scrolling (already at the top), or one
 *     that started on the grab handle / title. It claims by preventing the
 *     touchmove, which the browser only honours before it starts scrolling —
 *     hence the small classification window and the never-claim-upward rule.
 *   • Anything else is marked dead for the rest of that touch. The old code
 *     prevented the first moves speculatively and then bailed out; the browser
 *     had already written the gesture off as non-scrolling by then, which is
 *     why scrolling back up took three or four tries.
 * Release past 25% of the sheet height or a fast flick dismisses through the
 * SAME closeSheet() path (history/onDismiss included); otherwise it springs back.
 */
function wireSwipeToDismiss(sheet, backdrop) {
  const grab = sheet.querySelector(".sheet-grab");
  const header = sheet.querySelector("h2");
  const CLAIM = 8; // px of travel before a gesture is classified
  const isTextEntry = (n) => n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT" || n.isContentEditable);

  let id = null;         // the touch we're following
  let dead = true;       // classified as someone else's gesture (the default)
  let dragging = false;  // classified as ours
  let fromChrome = false; // started on the handle/title, which never scrolls
  let startX = 0, startY = 0, sheetH = 1;
  let moves = [];

  const find = (e) => [...e.changedTouches, ...e.touches].find((t) => t.identifier === id);

  function springBack() {
    if (typeof gsap === "undefined") { backdrop.style.opacity = ""; return; }
    if (motionOK()) {
      gsap.to(sheet, { y: 0, duration: 0.35, ease: "power3.out" });
      gsap.to(backdrop, { opacity: 1, duration: 0.25 });
    } else {
      gsap.set(sheet, { y: 0 });
      gsap.set(backdrop, { opacity: 1 });
    }
  }

  function onStart(e) {
    if (e.touches.length > 1) { // second finger: pinch/zoom, not a dismiss
      if (dragging) { dragging = false; springBack(); }
      dead = true;
      return;
    }
    const t = e.touches[0];
    const onChrome = (grab && grab.contains(t.target)) || (header && header.contains(t.target));
    dead = !onChrome && isTextEntry(t.target) && document.activeElement === t.target; // leave text editing alone
    dragging = false;
    fromChrome = !!onChrome;
    id = t.identifier;
    startX = t.clientX;
    startY = t.clientY;
    sheetH = sheet.getBoundingClientRect().height || sheet.offsetHeight || 1;
    moves = [{ t: performance.now(), y: startY }];
  }

  function onMove(e) {
    if (dead) return;
    const t = find(e);
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (!dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < CLAIM) return; // below intent threshold
      // Horizontal is the pager's, upward is content scrolling, and a sheet
      // with room left to scroll up keeps its own gesture. None of them ours.
      if (Math.abs(dx) > Math.abs(dy)) { dead = true; return; }
      if (!fromChrome && (dy <= 0 || sheet.scrollTop > 0)) { dead = true; return; }
      dragging = true;
    }

    if (e.cancelable) e.preventDefault(); // nothing may scroll under the drag
    moves.push({ t: performance.now(), y: t.clientY });
    if (moves.length > 6) moves.shift();

    const y = Math.max(0, dy); // ignore upward drag past the resting position
    const progress = Math.min(1, y / sheetH);
    if (typeof gsap !== "undefined") {
      gsap.set(sheet, { y });
      gsap.set(backdrop, { opacity: 1 - progress * 0.9 });
    } else {
      backdrop.style.opacity = String(1 - progress * 0.9);
    }
  }

  function onEnd(e) {
    if (!dragging) { dead = true; return; }
    dragging = false;
    dead = true;

    // touchcancel can carry stale coordinates — trust the last real sample.
    const t = find(e);
    const first = moves[0], last = moves[moves.length - 1];
    const endY = e.type === "touchcancel" || !t ? last.y : t.clientY;
    const dy = Math.max(0, endY - startY);
    const dt = Math.max(1, last.t - first.t);
    const velocity = (last.y - first.y) / dt; // px/ms, downward positive

    if (dy > sheetH * 0.25 || velocity > 0.6) {
      // Fold the drag offset into yPercent so closeSheet's own 0->100% exit
      // tween continues smoothly from here — one close path, no divergent
      // animation logic.
      if (typeof gsap !== "undefined") {
        const curY = gsap.getProperty(sheet, "y") || 0;
        const curPct = gsap.getProperty(sheet, "yPercent") || 0;
        const pct = Math.max(0, Math.min(100, curPct + (curY / sheetH) * 100));
        gsap.set(sheet, { y: 0, yPercent: pct });
      }
      closeSheet();
    } else {
      springBack();
    }
  }

  sheet.addEventListener("touchstart", onStart, { passive: true });
  sheet.addEventListener("touchmove", onMove, { passive: false });
  sheet.addEventListener("touchend", onEnd);
  sheet.addEventListener("touchcancel", onEnd);
}

export function closeSheet(fromPop = false) {
  if (!current) return;
  const { backdrop, sheet, release, onDismiss, closed } = current;
  current = null;
  release();
  for (const fn of closed || []) { try { fn(); } catch (err) { console.warn(err); } }
  onDismiss && onDismiss();
  if (!fromPop && history.state && history.state.batwaSheet) history.back();

  animTo(backdrop, { opacity: 0, duration: 0.22, onComplete: () => backdrop.remove() });
  if (isDesktop()) {
    animTo(sheet, { opacity: 0, scale: 0.94, duration: 0.22, ease: "power2.in", onComplete: () => sheet.remove() });
  } else {
    animTo(sheet, { yPercent: 100, duration: 0.32, ease: "power3.in", onComplete: () => sheet.remove() });
  }
}

window.addEventListener("popstate", () => { if (current) closeSheet(true); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && current) closeSheet(); });

/* ============================================================
   Building blocks
   ============================================================ */

function field(labelText, inputEl, errorText) {
  const f = el("div", { class: "field" });
  const id = "f-" + Math.random().toString(36).slice(2, 8);
  inputEl.id = id;
  f.append(el("label", { for: id }, labelText), inputEl);
  if (errorText) f.append(el("div", { class: "field-error" }, errorText));
  return f;
}

/**
 * Amount input, plus quick math: type `120+80` and a hint under the field
 * shows the running total; blur (or submit) replaces the text with the result.
 * Android's decimal keypad has no operators, so the field also gets a
 * four-button row that inserts one at the caret without stealing focus.
 */
function amountField(value = "") {
  const wrap = el("div", { class: "input-amount-wrap" });
  const input = el("input", {
    class: "input input-amount",
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    placeholder: "0",
    value: value ? String(value) : "",
  });
  wrap.append(el("span", { class: "cur-prefix" }, CURRENCY.symbol), input);
  const f = field("Amount", wrap, "Enter an amount");
  f.querySelector("label").setAttribute("for", "");

  const hint = el("div", { class: "amt-hint", hidden: true });
  f.append(hint);

  function paintHint() {
    if (!looksLikeExpr(input.value)) { hint.hidden = true; return; }
    const v = evalAmountExpr(input.value);
    hint.hidden = false;
    hint.textContent = v == null ? "That's not a sum Batwa can work out" : `= ${fmtMoney(v)}`;
  }
  /** Fold a valid expression down to its result, so the field always submits a number. */
  function settle() {
    if (!looksLikeExpr(input.value)) return;
    const v = evalAmountExpr(input.value);
    if (v == null) return;
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  input.addEventListener("input", paintHint);
  input.addEventListener("blur", () => { settle(); hint.hidden = true; });
  paintHint();

  {
    const ops = el("div", { class: "amt-ops", hidden: true });
    const insert = (ch) => {
      const a = input.selectionStart ?? input.value.length;
      const b = input.selectionEnd ?? a;
      input.value = input.value.slice(0, a) + ch + input.value.slice(b);
      const at = a + ch.length;
      try { input.setSelectionRange(at, at); } catch {}
      input.focus();
      paintHint();
    };
    for (const [label, ch] of [["+", "+"], ["−", "-"], ["×", "*"], ["÷", "/"]]) {
      const b = el("button", { type: "button", class: "amt-op", "aria-label": `Insert ${ch}` }, label);
      // Cancelling touchstart keeps the caret, but it also cancels the click the
      // browser would have synthesised — which is why these used to do nothing on
      // a phone. Insert on pointerdown instead, and let click handle keyboard use.
      let lastPointer = 0;
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();           // keep focus (and the caret) in the input
        lastPointer = Date.now();
        buzz(6);
        insert(ch);
      });
      b.addEventListener("click", () => {
        // a click that follows our own pointerdown is the same tap; anything
        // else is Enter/Space on a focused button, which still has to work
        if (Date.now() - lastPointer < 700) return;
        buzz(6);
        insert(ch);
      });
      ops.append(b);
    }
    f.append(ops);
    input.addEventListener("focus", () => { ops.hidden = false; });
    // a tap on an operator can still blur the input on some browsers — give it a
    // beat to land, and keep the row up while the pointer is inside it
    input.addEventListener("blur", () => setTimeout(() => {
      if (!ops.contains(document.activeElement)) ops.hidden = true;
    }, 250));
  }

  return { f, input };
}

function parseAmount(raw) {
  const str = String(raw);
  if (looksLikeExpr(str)) return evalAmountExpr(str);
  const n = parseFloat(str.replace(/[, ]/g, ""));
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * After a shared bank SMS is saved, remember which account the user picked for
 * that brand — the next share from the same wallet lands on it by itself.
 */
async function rememberShareAccount(kind, accountId) {
  if (!kind || !accountId) return;
  try {
    const mem = (await getMeta("shareAccountMemory")) || {};
    if (mem[kind] === accountId) return;
    mem[kind] = accountId;
    await setMeta("shareAccountMemory", mem);
  } catch {}
}

/** One-line banner above a form that was filled in from a shared message. */
function prefillNote(prefill) {
  if (!prefill) return null;
  return el("p", { class: "form-note is-info", style: "margin-bottom:var(--s-4)" },
    el("span", {}, prefill.note && !prefill.amount
      ? "Filled from a shared message — Batwa couldn't read an amount."
      : "Filled from a shared message — check the amount."));
}

function toggleRow(labelText, checked, onFlip) {
  let on = checked;
  const sw = el("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(on) });
  sw.addEventListener("click", () => {
    on = !on;
    sw.setAttribute("aria-checked", String(on));
    buzz(6);
    onFlip(on);
  });
  const row = el("div", { class: "toggle-row" }, el("span", { class: "strong small" }, labelText), sw);
  return row;
}

let lastAccountId = null; // remember within the session

/**
 * Recent titles for this kind, newest first, de-duped case-insensitively.
 * Tapping one refills title + category + account from that entry, so a
 * repeated expense ("Groceries", "Hostel fees") is two taps instead of typing.
 */
function recentTitles(kind, limit = 6) {
  const seen = new Map();
  const sorted = [...state.entries]
    .filter((e) => e.kind === kind && e.title && !e.isAdjustment)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  for (const e of sorted) {
    const key = e.title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.set(key, e);
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

/**
 * Chip row under the title field, filtered as you type: an empty field offers
 * the latest few, typing narrows to the titles that contain what you've typed,
 * and nothing matching means no row at all — a suggestion you didn't mean is
 * worse than none. `onPick` receives the source entry.
 */
function suggestionRow(kind, input, onPick) {
  const all = recentTitles(kind, 24);
  if (!all.length) return null;
  const row = el("div", { class: "suggest-row" });
  const label = el("span", { class: "suggest-label xsmall muted" }, "Recent");

  function paint() {
    const q = input.value.trim().toLowerCase();
    const matches = (q ? all.filter((e) => e.title.toLowerCase().includes(q)) : all).slice(0, 6);
    row.replaceChildren();
    row.hidden = !matches.length;
    if (!matches.length) return;
    row.append(label);
    for (const e of matches) {
      row.append(el("button", {
        type: "button",
        class: "suggest-chip",
        onclick: () => { buzz(6); onPick(e); paint(); },
      }, e.title));
    }
  }

  input.addEventListener("input", paint);
  paint();
  return row;
}

/** Horizontal account chips. Only shows when accounts exist. */
function accountPicker(selectedId, onChange) {
  if (!state.accounts.length) return { root: null, get: () => null };
  let picked = selectedId !== undefined ? selectedId : lastAccountId;
  if (picked && !state.accounts.some((a) => a.id === picked)) picked = null;
  const row = el("div", { class: "filter-row", style: "margin:0" });
  const mk = (id, label, logoHtml = "") => {
    const b = el("button", { type: "button", class: `acc-chip ${picked === id ? "is-active" : ""}` });
    b.innerHTML = `${logoHtml}<span>${label}</span>`;
    b.addEventListener("click", () => {
      picked = id;
      lastAccountId = id;
      [...row.children].forEach((c) => c.classList.remove("is-active"));
      b.classList.add("is-active");
      buzz(6);
      onChange && onChange(picked);
    });
    return b;
  };
  for (const a of state.accounts) row.append(mk(a.id, a.name, logoTile(a.kind, 22)));
  row.append(mk(null, "No account"));
  const f = el("div", { class: "field" });
  f.append(el("label", {}, "Account"), row);
  return { root: f, get: () => picked };
}

/**
 * The "is there actually money for this" line under a form.
 *   info  — how much the chosen account holds, stated plainly
 *   warn  — over the balance, but nothing moves yet (a pending expense is a
 *           plan; the ledger is built to carry it as Committed)
 *   block — over the balance and the money would leave now, so the button
 *           below it is disabled and this says why
 */
function fundsNote() {
  const node = el("p", { class: "form-note", hidden: true });
  return {
    node,
    set(level, text = "") {
      node.hidden = !level;
      if (!level) return;
      node.className = `form-note is-${level}`;
      node.innerHTML = level === "info" ? "" : icon("alert", 15);
      node.append(el("span", {}, text));
    },
  };
}

function setError(fieldEl, on) {
  fieldEl.classList.toggle("has-error", on);
  if (on && motionOK()) gsap.fromTo(fieldEl, { x: 0 }, { x: 8, duration: 0.05, repeat: 5, yoyo: true, clearProps: "x" });
}

/**
 * Delete control appended to the end of an edit sheet (income or expense).
 * Everything happens in-place in this same sheet — no nested sheet is
 * opened, so closeSheet()'s single history.back() stays the only history
 * transition (chaining closeSheet() -> openSheet() here would double-push
 * history state, since the codebase's own nested-reopen guard in openSheet
 * only avoids that by skipping history.back() entirely).
 *
 * Non-recurring: tap-to-arm, tap-again-to-confirm (3s revert), mirroring
 * home.js's delete affordance without a second sheet.
 * Recurring (has seriesId): reveals the same "just this one / this and
 * future / cancel" choice home.js's card delete offers, inline.
 */
function deleteRow(entry, { kindLabel, isExpense }) {
  const wrap = el("div", { style: "margin-top:var(--s-2)" }, el("div", { class: "divider" }));
  const isRecurring = isExpense && entry.recurrence !== "one-time" && !!entry.seriesId;
  const accName = entry.accountId ? accountName(entry.accountId) : null;
  const returning = isExpense && entry.status === "paid" && accName
    ? `${fmtMoney(entry.amount)} will return to ${accName}.`
    : `This ${kindLabel} will be permanently deleted.`;

  async function finish(kind) {
    if (kind === "future") {
      const removed = await deleteSeriesFuture(entry.id);
      closeSheet();
      toast(`Deleted ${removed.length} upcoming`, { icon: icon("trash", 17), undo: () => restoreEntries(removed) });
    } else {
      const removed = await deleteEntry(entry.id);
      closeSheet();
      toast("Deleted", { icon: icon("trash", 17), undo: () => restoreEntries([removed]) });
    }
  }

  if (isRecurring) {
    const delBtn = el("button", { type: "button", class: "btn btn-danger btn-block" }, `Delete ${kindLabel}`);
    const hint = el("p", { class: "muted xsmall", style: "margin:8px 0 0;text-align:center" }, returning);
    const choices = el("div", { class: "stack", style: "display:none;margin-top:var(--s-2)" });
    choices.append(
      el("button", { type: "button", class: "btn btn-soft-danger btn-block", onclick: () => { buzz(12); finish("one"); } }, "Just this one"),
      el("button", { type: "button", class: "btn btn-danger btn-block", onclick: () => { buzz(12); finish("future"); } }, "This and all future"),
      el("button", {
        type: "button", class: "btn btn-ghost btn-block",
        onclick: () => { buzz(6); choices.style.display = "none"; delBtn.style.display = ""; hint.style.display = "none"; },
      }, "Cancel")
    );
    hint.style.display = "none";
    delBtn.addEventListener("click", () => {
      buzz(10);
      delBtn.style.display = "none";
      hint.style.display = "";
      choices.style.display = "";
    });
    wrap.append(delBtn, hint, choices);
    return wrap;
  }

  const delBtn = el("button", { type: "button", class: "btn btn-danger btn-block" }, `Delete ${kindLabel}`);
  const hint = el("p", { class: "muted xsmall", style: "margin:8px 0 0;text-align:center;display:none" }, returning);
  let confirming = false, timer = null;
  delBtn.addEventListener("click", () => {
    if (!confirming) {
      buzz(10);
      confirming = true;
      delBtn.textContent = "Tap again to confirm";
      hint.style.display = "";
      if (motionOK()) gsap.fromTo(delBtn, { scale: 1 }, { scale: 1.04, duration: 0.15, yoyo: true, repeat: 1 });
      timer = setTimeout(() => {
        confirming = false;
        delBtn.textContent = `Delete ${kindLabel}`;
        hint.style.display = "none";
      }, 3000);
    } else {
      buzz(16);
      clearTimeout(timer);
      finish("one");
    }
  });
  wrap.append(delBtn, hint);
  return wrap;
}

/* ============================================================
   Add Money
   ============================================================ */

function buildMoneyForm(entry, prefill = null) {
  const { f: amtF, input: amt } = amountField(entry?.amount ?? prefill?.amount);
  const desc = el("input", { class: "input", type: "text", placeholder: "Salary, freelance, gift…", value: entry?.title || prefill?.title || "" });
  const descF = field("Description", desc, "What is this money from?");
  if (!entry) {
    const sugg = suggestionRow("income", desc, (src) => {
      desc.value = src.title;
      if (!amt.value) amt.value = String(src.amount);
      if (cat.querySelector(`option[value="${CSS.escape(src.category)}"]`)) cat.value = src.category;
      setError(descF, false);
    });
    if (sugg) descF.append(sugg);
  }

  let pending = entry ? entry.status === "pending" : false;
  const date = el("input", { class: "input", type: "date", value: (entry?.paidAt || entry?.dueDate || "").slice(0, 10) || prefill?.date || isoDate() });
  const dateLabel = el("label", {}, pending ? "Expected date" : "Date");
  const dateF = el("div", { class: "field" }, dateLabel, date);
  const pendingWrap = el("div", { class: "field" },
    toggleRow("Mark as pending", pending, (v) => {
      pending = v;
      dateLabel.textContent = pending ? "Expected date" : "Date";
    }));

  // `null` from a prefill means "we couldn't tell" — leave the picker unset
  // rather than silently reusing the last account.
  const acc = accountPicker(entry ? entry.accountId : prefill ? prefill.accountId ?? null : undefined);
  // "+" opens the inline category editor under the row — never a nested sheet.
  const { field: catF, select: cat } =
    categoryField(entry?.category || prefill?.category || "Others", { label: "Category (optional)" });

  const save = el("button", { class: "btn btn-mint btn-block", type: "submit" },
    entry ? "Save changes" : "Add money");

  const form = el("form", {}, prefillNote(prefill), amtF, descF, dateF, pendingWrap, acc.root, catF, el("div", { class: "form-actions" }, save),
    entry ? deleteRow(entry, { kindLabel: "income", isExpense: false }) : null);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = parseAmount(amt.value);
    setError(amtF, !amount);
    setError(descF, !desc.value.trim());
    if (!amount || !desc.value.trim()) return;
    const data = {
      kind: "income",
      amount,
      title: desc.value.trim(),
      category: cat.value,
      status: pending ? "pending" : "paid",
      paidAt: pending ? null : new Date(date.value + "T12:00:00").toISOString(),
      dueDate: pending ? date.value : null,
      recurrence: "one-time",
      accountId: acc.get(),
    };
    if (entry) await updateEntry(entry.id, data);
    else await addEntry(data);
    if (prefill) await rememberShareAccount(prefill.providerKind, data.accountId);
    closeSheet();
    toast(
      entry ? "Income updated" : pending ? `${desc.value.trim()} added as pending` : `${CURRENCY.symbol} ${amount.toLocaleString()} added`,
      { icon: icon(pending ? "clock" : "banknote", 18) }
    );
  });
  return form;
}

export function addMoneySheet(entry = null, { prefill = null } = {}) {
  openSheet(entry ? "Edit income" : "Add money", (body) => body.append(buildMoneyForm(entry, prefill)));
}

/* ============================================================
   Add / Edit Expense
   ============================================================ */

function buildExpenseForm(entry, prefill = null) {
  const { f: amtF, input: amt } = amountField(entry?.amount ?? prefill?.amount);
  const title = el("input", { class: "input", type: "text", placeholder: "Hostel fees, groceries…", value: entry?.title || prefill?.title || "" });
  const titleF = field("Title", title, "Give it a title");

  let recurrence = entry?.recurrence || "one-time";
  const seg = segmented(
    [
      { label: "One-time", value: "one-time" },
      { label: "Weekly", value: "weekly" },
      { label: "Monthly", value: "monthly" },
    ],
    recurrence,
    (v) => (recurrence = v)
  );
  const segF = el("div", { class: "field" });
  segF.append(el("label", {}, "Type"), seg);

  const due = el("input", { class: "input", type: "date", value: entry?.dueDate || prefill?.date || isoDate() });
  const dueF = field("Due date", due, "Pick a due date");
  // `null` from a prefill means "we couldn't tell" — leave the picker unset
  // rather than silently reusing the last account.
  const acc = accountPicker(entry ? entry.accountId : prefill ? prefill.accountId ?? null : undefined, () => checkFunds());
  // "+" opens the inline category editor under the row — never a nested sheet.
  const { field: catF, select: cat } =
    categoryField(entry?.category || prefill?.category || "Others");
  const note = el("textarea", { class: "input", placeholder: "Anything to remember (optional)" });
  note.value = entry?.note || prefill?.note || "";
  const noteF = field("Note", note);

  if (!entry) {
    const sugg = suggestionRow("expense", title, (src) => {
      title.value = src.title;
      if (!amt.value) amt.value = String(src.amount);
      if (cat.querySelector(`option[value="${CSS.escape(src.category)}"]`)) cat.value = src.category;
      setError(titleF, false);
    });
    if (sugg) titleF.append(sugg);
  }

  let alreadyPaid = entry ? entry.status === "paid" : false;
  const paidRow = toggleRow("Mark as already paid", alreadyPaid, (v) => { alreadyPaid = v; checkFunds(); });
  const paidWrap = el("div", { class: "field" }, paidRow);

  const save = el("button", { class: "btn btn-primary btn-block", type: "submit" },
    entry ? "Save changes" : "Add expense");

  // Only new expenses are checked: an entry being edited has already moved its
  // money, so it is part of the balance it would be measured against.
  const funds = fundsNote();
  function checkFunds() {
    if (entry) return;
    const amount = parseAmount(amt.value);
    const id = acc.get();
    const bal = id ? accountBalance(id) : balances().total;
    if (amount == null || amount <= bal) { funds.set(null); save.disabled = false; return; }
    const held = id ? `${accountName(id)} only has ${fmtMoney(bal)}` : `You only have ${fmtMoney(bal)}`;
    const short = fmtMoney(amount - bal);
    if (alreadyPaid) {
      funds.set("block", `${held} — that's ${short} short. Untick "already paid" to plan it instead.`);
      save.disabled = true;
    } else {
      funds.set("warn", `${short} more than ${id ? accountName(id) : "you"} ${id ? "holds" : "have"} — it'll sit in Committed until it's paid.`);
      save.disabled = false;
    }
  }
  amt.addEventListener("input", checkFunds);
  checkFunds();

  const form = el("form", {}, prefillNote(prefill), amtF, titleF, segF, dueF, acc.root, catF, noteF, paidWrap, funds.node,
    el("div", { class: "form-actions" }, save),
    entry ? deleteRow(entry, { kindLabel: "expense", isExpense: true }) : null);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    const amount = parseAmount(amt.value);
    setError(amtF, !amount);
    setError(titleF, !title.value.trim());
    setError(dueF, !due.value);
    if (!amount || !title.value.trim() || !due.value) return;
    const data = {
      kind: "expense",
      amount,
      title: title.value.trim(),
      recurrence,
      dueDate: due.value,
      category: cat.value,
      note: note.value.trim(),
      status: alreadyPaid ? "paid" : "pending",
      paidAt: alreadyPaid ? (entry?.paidAt || new Date().toISOString()) : null,
      accountId: acc.get(),
    };
    if (entry) await updateEntry(entry.id, data);
    else await addEntry(data);
    if (prefill) await rememberShareAccount(prefill.providerKind, data.accountId);
    closeSheet();
    toast(entry ? "Expense updated" : "Expense added", { icon: icon("receipt", 18) });
  });
  return form;
}

export function addExpenseSheet(entry = null, { prefill = null } = {}) {
  openSheet(entry ? "Edit expense" : "Add expense", (body) => body.append(buildExpenseForm(entry, prefill)));
}

/* ============================================================
   Transfer
   ============================================================ */

function buildTransferForm() {
  if (state.accounts.length < 2) {
    return el("div", {},
      el("div", {
        class: "empty", style: "border:none;background:none;padding:8px 0 20px",
        html: `<div class="empty-ico">${icon("swap", 26)}</div><h3>Add another account</h3><p>You need at least two accounts to transfer between them.</p>`,
      }),
      el("button", { class: "btn btn-primary btn-block", type: "button", onclick: () => addAccountSheet() }, "Add account"),
    );
  }

  const { f: amtF, input: amt } = amountField();
  const note = el("textarea", { class: "input", placeholder: "Anything to remember (optional)" });
  const noteF = field("Note", note);

  let fromId = state.accounts.some((a) => a.id === lastAccountId) ? lastAccountId : state.accounts[0].id;
  let toId = state.accounts.find((a) => a.id !== fromId)?.id;

  const fromF = el("div", { class: "field" });
  const toF = el("div", { class: "field" });

  function chip(a, onPick) {
    const b = el("button", { type: "button", class: "acc-chip" });
    b.innerHTML = `${logoTile(a.kind, 22)}<span>${esc(a.name)}</span>`;
    b.addEventListener("click", () => { buzz(6); onPick(); });
    return b;
  }
  /** The picked account, alone, with a cross that hands the full list back. */
  function pickedChip(a, label, onClear) {
    const b = el("button", {
      type: "button",
      class: "acc-chip is-active is-picked",
      "aria-label": `${a.name} — change ${label} account`,
    });
    b.innerHTML = `${logoTile(a.kind, 22)}<span>${esc(a.name)}</span><span class="chip-x" aria-hidden="true">${icon("x", 14)}</span>`;
    b.addEventListener("click", () => { buzz(6); onClear(); });
    return b;
  }
  // Each side collapses to its selection so the form stays short, and clearing
  // one offers every account back. Picking the account the other side holds
  // swaps the two rather than dead-ending — with two accounts, "reselect" would
  // otherwise offer you only the account you just cleared.
  function paintSide(wrap, labelText, selectedId, onPick, onClear) {
    wrap.innerHTML = "";
    const row = el("div", { class: "filter-row", style: "margin:0" });
    const picked = state.accounts.find((a) => a.id === selectedId);
    if (picked) row.append(pickedChip(picked, labelText, onClear));
    else for (const a of state.accounts) row.append(chip(a, () => onPick(a.id)));
    wrap.append(el("label", {}, labelText), row, el("div", { class: "field-error" }, "Pick an account"));
  }
  function paintBoth() { paintFrom(); paintTo(); checkFunds(); }
  function paintFrom() {
    paintSide(fromF, "From", fromId,
      (id) => { if (id === toId) toId = fromId; fromId = id; setError(fromF, false); paintBoth(); },
      () => { fromId = null; paintBoth(); });
  }
  function paintTo() {
    paintSide(toF, "To", toId,
      (id) => { if (id === fromId) fromId = toId; toId = id; setError(toF, false); paintBoth(); },
      () => { toId = null; paintBoth(); });
  }
  const save = el("button", { class: "btn btn-primary btn-block", type: "submit" }, "Transfer");

  // A transfer moves money now, so there is no "plan it anyway" case here:
  // over the source balance and the button is off.
  const funds = fundsNote();
  function checkFunds() {
    const bal = fromId ? accountBalance(fromId) : null;
    const amount = parseAmount(amt.value);
    if (bal == null) { funds.set(null); save.disabled = false; return; }
    if (amount == null || amount <= bal) {
      funds.set("info", `${accountName(fromId)} has ${fmtMoney(bal)} to move.`);
      save.disabled = false;
      return;
    }
    funds.set("block", `${accountName(fromId)} only has ${fmtMoney(bal)} — that's ${fmtMoney(amount - bal)} short.`);
    save.disabled = true;
  }
  amt.addEventListener("input", checkFunds);
  paintBoth();

  const form = el("form", {}, amtF, fromF, toF, funds.node, noteF, el("div", { class: "form-actions" }, save));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    const amount = parseAmount(amt.value);
    setError(amtF, !amount);
    setError(fromF, !fromId);
    setError(toF, !toId);
    if (!amount || !fromId || !toId || fromId === toId) return;
    lastAccountId = fromId;
    await transferMoney({ fromAccountId: fromId, toAccountId: toId, amount, note: note.value });
    closeSheet();
    toast(`${fmtMoney(amount)} moved · ${accountName(fromId)} → ${accountName(toId)}`, { icon: icon("swap", 18) });
  });
  return form;
}

export function transferSheet() {
  openSheet("Transfer money", (body) => body.append(buildTransferForm()));
}

/** Read-only detail for a past transfer, opened from History — delete only, no edit. */
export function transferDetailSheet(entry) {
  openSheet("Transfer", (body) => {
    const fromAcc = state.accounts.find((a) => a.id === entry.fromAccountId);
    const toAcc = state.accounts.find((a) => a.id === entry.toAccountId);
    const dateIso = (entry.paidAt || entry.createdAt).slice(0, 10);

    const head = el("div", { class: "acc-sheet-head" });
    head.innerHTML = `
      ${logoTile(fromAcc?.kind || "bank", 40)}
      <div class="acc-sheet-head-text">
        <span class="acc-wash-name truncate">${esc(fromAcc?.name || "Removed account")} → ${esc(toAcc?.name || "Removed account")}</span>
        <span class="acc-fill-cap xsmall muted">${shortDate(dateIso)}</span>
      </div>
    `;
    body.append(head);
    body.append(el("div", { class: "field" },
      el("div", { class: "num", style: "font-size:1.7rem;font-weight:800;letter-spacing:-0.02em" }, fmtMoney(entry.amount))));
    if (entry.note) body.append(el("div", { class: "field" }, el("label", {}, "Note"), el("p", { class: "small" }, entry.note)));
    body.append(deleteTransferRow(entry, fromAcc?.name, toAcc?.name));
  });
}

function deleteTransferRow(entry, fromName, toName) {
  const wrap = el("div", { style: "margin-top:var(--s-2)" }, el("div", { class: "divider" }));
  const delBtn = el("button", { type: "button", class: "btn btn-danger btn-block" }, "Delete transfer");
  const hint = el("p", { class: "muted xsmall", style: "margin:8px 0 0;text-align:center;display:none" },
    `${fmtMoney(entry.amount)} will return to ${fromName || "the source account"} and be removed from ${toName || "the destination account"}.`);
  let confirming = false, timer = null;
  delBtn.addEventListener("click", () => {
    if (!confirming) {
      buzz(10);
      confirming = true;
      delBtn.textContent = "Tap again to confirm";
      hint.style.display = "";
      if (motionOK()) gsap.fromTo(delBtn, { scale: 1 }, { scale: 1.04, duration: 0.15, yoyo: true, repeat: 1 });
      timer = setTimeout(() => {
        confirming = false;
        delBtn.textContent = "Delete transfer";
        hint.style.display = "none";
      }, 3000);
    } else {
      buzz(16);
      clearTimeout(timer);
      (async () => {
        const removed = await deleteEntry(entry.id);
        closeSheet();
        toast("Transfer deleted", { icon: icon("trash", 17), undo: () => restoreEntries([removed]) });
      })();
    }
  });
  wrap.append(delBtn, hint);
  return wrap;
}

/* ============================================================
   Quick add — Expense / Income / Transfer, swipeable tabs
   ============================================================ */

const QA_TABS = [
  { key: "expense", label: "Expense" },
  { key: "income", label: "Income" },
  { key: "transfer", label: "Transfer" },
];

/**
 * Center-FAB entry point: one sheet, three swipeable tabs, each a fresh add form.
 *
 * The pager is a transformed track driven from here rather than a native
 * scroll-snap container, because the two are not equivalent inside a sheet:
 *   • touch-action can then be `pan-y`, so the browser keeps vertical panning
 *     and the sheet scrolls on the first swipe — even with the finger on a form.
 *     A pager owning `pan-x` swallowed those swipes entirely.
 *   • A flick moves exactly one tab, decided here from distance and velocity.
 *     Momentum used to sail past Income and land on Transfer, because
 *     `scroll-snap-stop: always` is not honoured for flings in every engine.
 *   • `pos` — the fractional page position — is the single source of truth, so
 *     the height interpolates between two cached measurements as the finger
 *     moves instead of a tween chasing the gesture from behind, and nothing
 *     reads layout mid-drag. That chase is what felt laggy.
 */
export function quickAddSheet(initialKind = "expense") {
  openSheet(null, (body) => {
    const N = QA_TABS.length;
    const startIndex = Math.max(0, QA_TABS.findIndex((t) => t.key === initialKind));
    const uid = Math.random().toString(36).slice(2, 7);

    const tabs = el("div", { class: "segmented qa-tabs", role: "tablist", "aria-label": "What to add" });
    const pager = el("div", { class: "qa-pager" });
    const track = el("div", { class: "qa-track" });
    pager.append(track);

    const pages = QA_TABS.map((t, i) => {
      const page = el("div", {
        class: "qa-page",
        role: "tabpanel",
        id: `qa-panel-${uid}-${i}`,
        "aria-labelledby": `qa-tab-${uid}-${i}`,
      });
      page.append(
        t.key === "expense" ? buildExpenseForm(null)
          : t.key === "income" ? buildMoneyForm(null)
            : buildTransferForm()
      );
      track.append(page);
      return page;
    });

    const tabBtns = QA_TABS.map((t, i) => {
      const b = el("button", {
        type: "button",
        role: "tab",
        id: `qa-tab-${uid}-${i}`,
        "aria-controls": `qa-panel-${uid}-${i}`,
        onclick: () => { buzz(6); settle(i); },
      }, t.label);
      tabs.append(b);
      return b;
    });

    /* ---------- state ---------- */
    const heights = new Array(N).fill(0);
    let width = 1;
    let pos = startIndex;    // fractional page position — the source of truth
    let active = startIndex; // committed tab
    let painted = -1;
    let posTween = null;
    let hTween = null;

    function measure() {
      width = pager.clientWidth || pager.getBoundingClientRect().width || 1;
      for (let i = 0; i < N; i++) heights[i] = Math.ceil(pages[i].getBoundingClientRect().height);
    }

    // Only ever one writer for the container height, so a content-driven tween
    // and the per-frame drag writes can't fight over it. The track is sized
    // along with the pager: as a flex row it is otherwise as tall as the
    // TALLEST page, which would leave the pager scrollable past the end of a
    // short tab into the empty space under it.
    const boxes = [pager, track];
    function setHeight(h, animate) {
      if (hTween) { hTween.kill(); hTween = null; }
      if (!(h > 0)) return;
      if (animate && motionOK()) {
        hTween = gsap.to(boxes, { height: h, duration: 0.24, ease: "power2.out", onComplete: () => (hTween = null) });
      } else {
        for (const b of boxes) b.style.height = `${h}px`;
      }
    }

    function paintTabs(i) {
      if (i === painted) return;
      painted = i;
      tabBtns.forEach((b, idx) => {
        b.classList.toggle("is-active", idx === i);
        b.setAttribute("aria-selected", String(idx === i));
        b.tabIndex = idx === i ? 0 : -1; // roving tabindex: Tab leaves the strip for the form
      });
    }

    function render() {
      track.style.transform = `translate3d(${(-pos * width).toFixed(2)}px,0,0)`;
      const i = Math.max(0, Math.min(N - 1, Math.floor(pos)));
      const j = Math.min(N - 1, i + 1);
      const f = Math.max(0, Math.min(1, pos - i));
      setHeight(Math.ceil(heights[i] + (heights[j] - heights[i]) * f), false);
      paintTabs(Math.max(0, Math.min(N - 1, Math.round(pos))));
    }

    /** Settle on a tab: only the pane you can see stays focusable and readable. */
    function commit(i) {
      active = i;
      paintTabs(i);
      pages.forEach((p, idx) => (idx === i ? p.removeAttribute("inert") : p.setAttribute("inert", "")));
    }

    /** Re-read the page we landed on — a cached height can only go stale. */
    function lockHeight() {
      const h = Math.ceil(pages[active].getBoundingClientRect().height);
      if (h) heights[active] = h;
      setHeight(heights[active], false);
    }

    function settle(i) {
      const to = Math.max(0, Math.min(N - 1, i));
      commit(to);
      if (posTween) { posTween.kill(); posTween = null; }
      if (!motionOK()) { pos = to; render(); lockHeight(); return; }
      const s = { p: pos };
      posTween = gsap.to(s, {
        p: to,
        duration: 0.34,
        ease: "power3.out",
        onUpdate: () => { pos = s.p; render(); },
        onComplete: () => { posTween = null; pos = to; render(); lockHeight(); },
      });
    }

    /* ---------- horizontal drag (the tab swipe claims this axis) ---------- */
    const CLAIM = 8;
    let touchId = null, x0 = 0, y0 = 0, basePos = 0, lastX = 0, lastT = 0, vx = 0;
    let dragging = false, dead = true, innerX = null;

    /** The chip row (recents, accounts) under the finger, if it scrolls sideways. */
    function scrollerX(node) {
      for (let n = node; n && n !== pager; n = n.parentElement) {
        if (n.scrollWidth > n.clientWidth + 1) {
          const ox = getComputedStyle(n).overflowX;
          if (ox === "auto" || ox === "scroll") return n;
        }
      }
      return null;
    }
    /** Has it got room left to move the way the finger is going? */
    function canScrollX(elm, dx) {
      const max = elm.scrollWidth - elm.clientWidth;
      return dx < 0 ? elm.scrollLeft < max - 1 : elm.scrollLeft > 1;
    }

    pager.addEventListener("touchstart", (e) => {
      if (e.touches.length > 1) { dead = true; return; }
      const t = e.touches[0];
      innerX = scrollerX(t.target);
      // A previous drag that never got its touchend (the browser can swallow
      // one) would otherwise have us measure from a half-dragged position and
      // compound the error. Re-anchor on the committed tab instead.
      if (dragging) { pos = active; render(); }
      touchId = t.identifier;
      x0 = lastX = t.clientX;
      y0 = t.clientY;
      lastT = performance.now();
      vx = 0;
      dead = false;
      dragging = false;
      if (posTween) { posTween.kill(); posTween = null; } // catch a tab mid-flight
      basePos = pos;
    }, { passive: true });

    pager.addEventListener("touchmove", (e) => {
      if (dead) return;
      const t = [...e.touches].find((x) => x.identifier === touchId);
      if (!t) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (!dragging) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < CLAIM) return;
        if (Math.abs(dx) <= Math.abs(dy)) { dead = true; return; } // vertical — the sheet's
        // Horizontal, but starting on a chip row with somewhere left to go:
        // that scroll is the browser's, not a tab change.
        if (innerX && canScrollX(innerX, dx)) { dead = true; return; }
        dragging = true;
      }
      e.stopPropagation();                  // never also read as a dismiss drag
      if (e.cancelable) e.preventDefault(); // no diagonal scrolling under the drag
      const now = performance.now();
      vx = (t.clientX - lastX) / Math.max(1, now - lastT); // px/ms
      lastX = t.clientX;
      lastT = now;
      let p = basePos - dx / width;
      if (p < 0) p *= 0.35;                                  // rubber band at the ends
      else if (p > N - 1) p = N - 1 + (p - (N - 1)) * 0.35;
      pos = p;
      render();
    }, { passive: false });

    function endDrag() {
      if (!dragging) { dead = true; return; }
      dragging = false;
      dead = true;
      const from = Math.round(basePos);
      const moved = (lastX - x0) / width;                        // in pages; + = towards the previous tab
      const v = performance.now() - lastT > 100 ? 0 : vx;        // finger paused before lifting: no flick
      // Exactly one tab per gesture, whatever the fling does.
      let target = from;
      if (Math.abs(v) > 0.4) target = from + (v < 0 ? 1 : -1);
      else if (moved < -0.25) target = from + 1;
      else if (moved > 0.25) target = from - 1;
      if (target !== from) buzz(6);
      settle(target);
    }
    pager.addEventListener("touchend", endDrag);
    pager.addEventListener("touchcancel", endDrag);

    tabs.addEventListener("keydown", (e) => {
      const i = tabBtns.indexOf(document.activeElement);
      if (i < 0) return;
      const to = e.key === "ArrowRight" ? i + 1
        : e.key === "ArrowLeft" ? i - 1
          : e.key === "Home" ? 0
            : e.key === "End" ? N - 1
              : null;
      if (to == null) return;
      e.preventDefault();
      const n = Math.max(0, Math.min(N - 1, to));
      buzz(6);
      settle(n);
      tabBtns[n].focus();
    });

    // Nothing should scroll the pager itself — focus tries to when the
    // on-screen keyboard opens, and that would double-offset the track.
    pager.addEventListener("scroll", () => { pager.scrollLeft = 0; pager.scrollTop = 0; });

    // Bank logos are <img>s that arrive after the forms are measured, and a
    // chip growing by a few pixels used to push the submit button behind the
    // clip. load doesn't bubble, so listen for it on the way down.
    pager.addEventListener("load", () => {
      measure();
      if (!dragging && !posTween) lockHeight();
    }, true);

    // The inline category editor opened or closed inside one of the forms: the
    // cached page heights are now wrong and the Save button would be clipped.
    // One frame later, so the panel's own layout has landed.
    pager.addEventListener("cat-editor-resize", () => {
      requestAnimationFrame(() => {
        measure();
        if (!dragging && !posTween) setHeight(heights[active], true);
      });
    });

    /* ---------- keep the cached measurements honest ---------- */
    // Width has to be watched on the pager itself, not just on window resize:
    // it also changes when the sheet gains or loses its scrollbar as a taller
    // or shorter tab comes in, and a stale width offsets the track by pixels
    // that add up to a visibly half-scrolled page.
    const ro = new ResizeObserver((entries) => {
      if (onResize()) return; // width moved: everything was just re-measured
      let changed = false;
      for (const entry of entries) {
        const i = pages.indexOf(entry.target);
        if (i < 0) continue;
        const h = Math.ceil(entry.target.getBoundingClientRect().height);
        if (h && h !== heights[i]) { heights[i] = h; changed = true; }
      }
      if (!changed) return;
      // A validation error or a revealed row just grew the pane: ease to the
      // new height. The old fixed height simply clipped it.
      if (dragging || posTween) render();
      else setHeight(heights[active], true);
    });

    /** Re-anchor on a width change. Returns true if it acted. */
    function onResize() {
      if (Math.abs((pager.clientWidth || width) - width) < 1) return false; // our own height writes
      measure();
      if (!dragging) pos = active; // never left sitting between two pages
      render();
      return true;
    }

    onSheetMounted(() => {
      measure();
      commit(startIndex);
      pos = startIndex;
      render();
      for (const p of pages) ro.observe(p);
      ro.observe(pager);
      addEventListener("resize", onResize);
      addEventListener("orientationchange", onResize);
    });
    onSheetClosed(() => {
      ro.disconnect();
      removeEventListener("resize", onResize);
      removeEventListener("orientationchange", onResize);
      if (posTween) posTween.kill();
      if (hTween) hTween.kill();
    });

    body.append(tabs, pager);
  });
}

/* ============================================================
   Confirm / choice sheets
   ============================================================ */

/** Yes/no confirm. Resolves boolean. */
export function confirmSheet({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openSheet(title, (body) => {
      body.append(el("p", { class: "muted", style: "margin-bottom:16px" }, message));
      body.append(
        el("div", { class: "form-actions" },
          el("button", { class: "btn btn-ghost", onclick: () => { finish(false); closeSheet(); } }, "Cancel"),
          el("button", {
            class: danger ? "btn btn-danger" : "btn btn-primary",
            onclick: () => { finish(true); closeSheet(); },
          }, confirmLabel)
        )
      );
    }, { onDismiss: () => finish(false) });
  });
}

/** Multi-option choice. Resolves the picked value or null. */
export function chooseSheet({ title, message, options }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    openSheet(title, (body) => {
      if (message) body.append(el("p", { class: "muted", style: "margin-bottom:16px" }, message));
      const stack = el("div", { class: "stack" });
      for (const opt of options) {
        stack.append(
          el("button", {
            class: `btn btn-block ${opt.style || "btn-ghost"}`,
            onclick: () => { finish(opt.value); closeSheet(); },
          }, opt.label)
        );
      }
      body.append(stack);
    }, { onDismiss: () => finish(null) });
  });
}
