// Bottom sheets (mobile) / centered modals (desktop):
// add money, add/edit expense, confirm, and multi-choice sheets.

import { $, el, esc, anim, animTo, trapFocus, motionOK, buzz } from "../util/dom.js";
import { state, addEntry, updateEntry, deleteEntry, deleteSeriesFuture, restoreEntries } from "../ledger.js";
import { isoDate, fmtMoney } from "../util/format.js";
import { CURRENCY } from "../util/format.js";
import { toast } from "./toast.js";
import { logoTile, accountName } from "./accounts.js";
import { icon } from "./icons.js";

let current = null; // { backdrop, sheet, release, resolveClosed }

const isDesktop = () => matchMedia("(min-width: 640px)").matches;

export function sheetOpen() { return !!current; }

/** Open a sheet. `build(body)` fills the content. Returns close(). */
export function openSheet(title, build, { onDismiss } = {}) {
  if (current) closeSheet(true);

  const backdrop = el("div", { class: "sheet-backdrop", onclick: () => closeSheet() });
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title });
  sheet.append(el("div", { class: "sheet-grab", "aria-hidden": "true" }));
  if (title) sheet.append(el("h2", {}, title));
  const body = el("div", {});
  sheet.append(body);
  build(body);

  const root = $("#sheet-root");
  root.append(backdrop, sheet);

  const release = trapFocus(sheet);
  current = { backdrop, sheet, release, onDismiss };

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

  const first = sheet.querySelector("input, select, textarea, button");
  if (first && !("ontouchstart" in window)) setTimeout(() => first.focus(), 80);
  return closeSheet;
}

/**
 * Native-feel swipe-down-to-dismiss for the mobile sheet.
 * Dragging from the grab handle / title always works; dragging from the
 * body only engages once the sheet's own scroll (it IS the scroll
 * container — see .sheet{overflow-y:auto}) is at the top, so inner
 * scrolling isn't hijacked. Release past ~25% of the sheet height or a
 * fast flick dismisses through the SAME closeSheet() path (history/
 * onDismiss handling included); otherwise it springs back.
 */
function wireSwipeToDismiss(sheet, backdrop) {
  const grab = sheet.querySelector(".sheet-grab");
  const header = sheet.querySelector("h2");
  const isTextEntry = (n) => n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT" || n.isContentEditable);

  let pending = false;   // pointer is down, gesture not yet classified
  let dragging = false;  // classified as a vertical drag
  let fromChrome = false; // started on the handle/header (always draggable)
  let pointerId = null;
  let startX = 0, startY = 0;
  let sheetH = 0;
  let moves = [];

  function reset() {
    pending = false;
    dragging = false;
    pointerId = null;
    moves = [];
  }

  // touch-action can't be changed mid-gesture (it's evaluated at touch
  // start), and preventDefault on pointermove never stops scrolling — so
  // without this the browser claims the touch for scroll and fires
  // pointercancel, killing the drag. Claiming the touchmove keeps the
  // pointer stream alive; the grab/title are covered by CSS touch-action.
  function onTouchMove(e) {
    if (!pending && !dragging) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dy = t.clientY - startY;
    if (dragging || fromChrome || (sheet.scrollTop <= 0 && dy > 0)) {
      if (e.cancelable) e.preventDefault();
    }
  }

  function onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const onChrome = (grab && grab.contains(e.target)) || (header && header.contains(e.target));
    if (!onChrome) {
      if (isTextEntry(e.target) && document.activeElement === e.target) return; // let text editing alone
      if (sheet.scrollTop > 0) return; // inner content is scrolled — let it scroll
    }
    fromChrome = !!onChrome;
    pending = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    sheetH = sheet.getBoundingClientRect().height || sheet.offsetHeight || 1;
    moves = [{ t: performance.now(), y: startY }];
  }

  function onMove(e) {
    if (!pending || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dyRaw = e.clientY - startY;

    if (!dragging) {
      if (Math.abs(dyRaw) < 8) return; // below intent threshold
      if (Math.abs(dx) > Math.abs(dyRaw)) { pending = false; return; } // horizontal gesture — not ours
      if (!fromChrome) {
        if (dyRaw <= 0) { pending = false; return; } // upward — that's content scrolling, not ours
        if (sheet.scrollTop > 0) { pending = false; return; } // scrolled since down
      }
      dragging = true;
      try { sheet.setPointerCapture(pointerId); } catch {}
    }

    const dy = Math.max(0, dyRaw); // ignore upward drag past resting position
    moves.push({ t: performance.now(), y: e.clientY });
    if (moves.length > 6) moves.shift();

    if (typeof gsap !== "undefined") gsap.set(sheet, { y: dy });
    const progress = Math.min(1, dy / sheetH);
    if (typeof gsap !== "undefined") gsap.set(backdrop, { opacity: 1 - progress * 0.9 });
    else backdrop.style.opacity = String(1 - progress * 0.9);
  }

  function onUp(e) {
    if (!pending || e.pointerId !== pointerId) return;
    if (!dragging) { reset(); return; }
    try { sheet.releasePointerCapture(pointerId); } catch {}

    // pointercancel may carry zeroed coordinates — trust the last real sample
    const first = moves[0], last = moves[moves.length - 1];
    const endY = e.type === "pointercancel" ? last.y : e.clientY;
    const dy = Math.max(0, endY - startY);
    const dt = Math.max(1, last.t - first.t);
    const velocity = (last.y - first.y) / dt; // px/ms
    const shouldDismiss = dy > sheetH * 0.25 || velocity > 0.6;

    if (shouldDismiss) {
      // Fold the drag offset into yPercent so closeSheet's own 0->100%
      // exit tween continues smoothly from here — one close path, no
      // divergent animation logic.
      if (typeof gsap !== "undefined") {
        const curY = gsap.getProperty(sheet, "y") || 0;
        const curPct = gsap.getProperty(sheet, "yPercent") || 0;
        const pct = Math.max(0, Math.min(100, curPct + (curY / sheetH) * 100));
        gsap.set(sheet, { y: 0, yPercent: pct });
      }
      reset();
      closeSheet();
    } else if (motionOK()) {
      gsap.to(sheet, { y: 0, duration: 0.35, ease: "power3.out" });
      gsap.to(backdrop, { opacity: 1, duration: 0.25 });
      reset();
    } else {
      if (typeof gsap !== "undefined") gsap.set(sheet, { y: 0 });
      backdrop.style.opacity = "";
      reset();
    }
  }

  sheet.addEventListener("pointerdown", onDown);
  sheet.addEventListener("pointermove", onMove);
  sheet.addEventListener("pointerup", onUp);
  sheet.addEventListener("pointercancel", onUp);
  sheet.addEventListener("touchmove", onTouchMove, { passive: false });
}

export function closeSheet(fromPop = false) {
  if (!current) return;
  const { backdrop, sheet, release, onDismiss } = current;
  current = null;
  release();
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
  return { f, input };
}

function parseAmount(raw) {
  const n = parseFloat(String(raw).replace(/[, ]/g, ""));
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function categorySelect(selected) {
  const sel = el("select", { class: "input" });
  for (const c of state.categories) {
    sel.append(el("option", { value: c, selected: c === selected }, c));
  }
  return sel;
}

function segmented(options, active, onPick) {
  const seg = el("div", { class: "segmented", role: "tablist" });
  for (const opt of options) {
    const b = el("button", {
      type: "button",
      role: "tab",
      class: opt.value === active ? "is-active" : "",
      "aria-selected": String(opt.value === active),
      onclick: () => {
        [...seg.children].forEach((c) => { c.classList.remove("is-active"); c.setAttribute("aria-selected", "false"); });
        b.classList.add("is-active");
        b.setAttribute("aria-selected", "true");
        buzz(6);
        onPick(opt.value);
      },
    }, opt.label);
    seg.append(b);
  }
  return seg;
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

/** Chip row under the title field. `onPick` receives the source entry. */
function suggestionRow(kind, onPick) {
  const recents = recentTitles(kind);
  if (!recents.length) return null;
  const row = el("div", { class: "suggest-row" });
  row.append(el("span", { class: "suggest-label xsmall muted" }, "Recent"));
  for (const e of recents) {
    row.append(el("button", {
      type: "button",
      class: "suggest-chip",
      onclick: () => { buzz(6); onPick(e); },
    }, e.title));
  }
  return row;
}

/** Horizontal account chips. Only shows when accounts exist. */
function accountPicker(selectedId) {
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
    });
    return b;
  };
  for (const a of state.accounts) row.append(mk(a.id, a.name, logoTile(a.kind, 22)));
  row.append(mk(null, "No account"));
  const f = el("div", { class: "field" });
  f.append(el("label", {}, "Account"), row);
  return { root: f, get: () => picked };
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

export function addMoneySheet(entry = null) {
  openSheet(entry ? "Edit income" : "Add money", (body) => {
    const { f: amtF, input: amt } = amountField(entry?.amount);
    const desc = el("input", { class: "input", type: "text", placeholder: "Salary, freelance, gift…", value: entry?.title || "" });
    const descF = field("Description", desc, "What is this money from?");
    if (!entry) {
      const sugg = suggestionRow("income", (src) => {
        desc.value = src.title;
        if (!amt.value) amt.value = String(src.amount);
        if (cat.querySelector(`option[value="${CSS.escape(src.category)}"]`)) cat.value = src.category;
        setError(descF, false);
      });
      if (sugg) descF.append(sugg);
    }
    const date = el("input", { class: "input", type: "date", value: (entry?.paidAt || "").slice(0, 10) || isoDate() });
    const dateF = field("Date", date);
    const acc = accountPicker(entry ? entry.accountId : undefined);
    const cat = categorySelect(entry?.category || "Others");
    const catF = field("Category (optional)", cat);

    const save = el("button", { class: "btn btn-mint btn-block", type: "submit" },
      entry ? "Save changes" : "Add money");

    const form = el("form", {}, amtF, descF, dateF, acc.root, catF, el("div", { class: "form-actions" }, save),
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
        paidAt: new Date(date.value + "T12:00:00").toISOString(),
        status: "paid",
        recurrence: "one-time",
        dueDate: null,
        accountId: acc.get(),
      };
      if (entry) await updateEntry(entry.id, data);
      else await addEntry(data);
      closeSheet();
      toast(entry ? "Income updated" : `${CURRENCY.symbol} ${amount.toLocaleString()} added`, { icon: icon("banknote", 18) });
    });
    body.append(form);
  });
}

/* ============================================================
   Add / Edit Expense
   ============================================================ */

export function addExpenseSheet(entry = null) {
  openSheet(entry ? "Edit expense" : "Add expense", (body) => {
    const { f: amtF, input: amt } = amountField(entry?.amount);
    const title = el("input", { class: "input", type: "text", placeholder: "Hostel fees, groceries…", value: entry?.title || "" });
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

    const due = el("input", { class: "input", type: "date", value: entry?.dueDate || isoDate() });
    const dueF = field("Due date", due, "Pick a due date");
    const acc = accountPicker(entry ? entry.accountId : undefined);
    const cat = categorySelect(entry?.category || "Others");
    const catF = field("Category", cat);
    const note = el("textarea", { class: "input", placeholder: "Anything to remember (optional)" });
    note.value = entry?.note || "";
    const noteF = field("Note", note);

    if (!entry) {
      const sugg = suggestionRow("expense", (src) => {
        title.value = src.title;
        if (!amt.value) amt.value = String(src.amount);
        if (cat.querySelector(`option[value="${CSS.escape(src.category)}"]`)) cat.value = src.category;
        setError(titleF, false);
      });
      if (sugg) titleF.append(sugg);
    }

    let alreadyPaid = entry ? entry.status === "paid" : false;
    const paidRow = toggleRow("Mark as already paid", alreadyPaid, (v) => (alreadyPaid = v));
    const paidWrap = el("div", { class: "field" }, paidRow);

    const save = el("button", { class: "btn btn-primary btn-block", type: "submit" },
      entry ? "Save changes" : "Add expense");

    const form = el("form", {}, amtF, titleF, segF, dueF, acc.root, catF, noteF, paidWrap,
      el("div", { class: "form-actions" }, save),
      entry ? deleteRow(entry, { kindLabel: "expense", isExpense: true }) : null);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
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
      closeSheet();
      toast(entry ? "Expense updated" : "Expense added", { icon: icon("receipt", 18) });
    });
    body.append(form);
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
