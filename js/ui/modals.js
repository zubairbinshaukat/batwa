// Bottom sheets (mobile) / centered modals (desktop):
// add money, add/edit expense, confirm, and multi-choice sheets.

import { $, el, esc, anim, animTo, trapFocus, motionOK, buzz } from "../util/dom.js";
import { state, addEntry, updateEntry } from "../ledger.js";
import { isoDate } from "../util/format.js";
import { CURRENCY } from "../util/format.js";
import { toast } from "./toast.js";
import { logoTile } from "./accounts.js";
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
  }

  const first = sheet.querySelector("input, select, textarea, button");
  if (first && !("ontouchstart" in window)) setTimeout(() => first.focus(), 80);
  return closeSheet;
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

    const form = el("form", {}, amtF, descF, dateF, acc.root, catF, el("div", { class: "form-actions" }, save));
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
      el("div", { class: "form-actions" }, save));

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
