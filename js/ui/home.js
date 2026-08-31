// Home: hero balances (blur + count-up reveal), upcoming expenses, quick actions.

import { $, el, esc, anim, animTo, motionOK, buzz } from "../util/dom.js";
import { fmtMoney, fmtCompact, fmtNum, dueHint, shortDate, greeting, CURRENCY } from "../util/format.js";
import { state, balances, pendingExpenses, markPaid, unmarkPaid, deleteEntry, deleteSeriesFuture, restoreEntries } from "../ledger.js";
import { addMoneySheet, addExpenseSheet, confirmSheet, chooseSheet } from "./modals.js";
import { toast } from "./toast.js";
import { renderAccountsRow, accountName } from "./accounts.js";
import { icon, catIcon } from "./icons.js";

// Session-only: every launch starts blurred. Never persisted.
let revealed = false;
let hasCountedUp = false;

/* ---------- exact-amount tooltip (tap on mobile, hover on desktop) ---------- */
let tipEl = null;
function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }
document.addEventListener("pointerdown", (e) => {
  if (tipEl && !e.target.closest("[data-tip]")) hideTip();
});
function showTip(target, text) {
  hideTip();
  tipEl = el("div", { class: "tip", role: "tooltip" }, text);
  document.body.append(tipEl);
  const r = target.getBoundingClientRect();
  const tr = tipEl.getBoundingClientRect();
  let x = r.left + r.width / 2 - tr.width / 2;
  x = Math.max(8, Math.min(x, innerWidth - tr.width - 8));
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${Math.max(8, r.top - tr.height - 10)}px`;
  anim(tipEl, { opacity: 0, y: 6, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.22, ease: "back.out(2)" });
}
function wireTips(root) {
  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tip]");
    if (!t || !revealed) return;
    tipEl && tipEl.dataset.for === t.dataset.tipId ? hideTip() : showTip(t, t.dataset.tip);
    if (tipEl) tipEl.dataset.for = t.dataset.tipId || "";
  });
  root.addEventListener("mouseover", (e) => {
    if (!matchMedia("(hover: hover)").matches || !revealed) return;
    const t = e.target.closest("[data-tip]");
    if (t) showTip(t, t.dataset.tip);
  });
  root.addEventListener("mouseout", (e) => {
    if (!matchMedia("(hover: hover)").matches) return;
    if (e.target.closest("[data-tip]")) hideTip();
  });
}

/* ---------- icons ---------- */
const eyeSVG = (open) => open
  ? '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>'
  : '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';


/* ---------- money spans ---------- */
function moneySpan(value, cls = "") {
  const id = "m" + Math.random().toString(36).slice(2, 8);
  return `<span class="money blurable ${cls}" data-tip="${fmtMoney(value)}" data-tip-id="${id}" data-value="${value}">${fmtCompact(value)}</span>`;
}

/* ---------- count-up on reveal ---------- */
function countUp(root) {
  const spans = [...root.querySelectorAll(".money[data-value]")];
  for (const s of spans) {
    const target = Number(s.dataset.value);
    if (!motionOK()) { s.textContent = fmtCompact(target); continue; }
    const o = { v: 0 };
    gsap.to(o, {
      v: target, duration: 1.1, ease: "power3.out",
      onUpdate: () => { s.textContent = fmtCompact(o.v); },
      onComplete: () => { s.textContent = fmtCompact(target); },
    });
  }
}

/* ============================================================ */

export function renderHome(view) {
  const b = balances();
  const pending = pendingExpenses();
  const negative = b.free < 0;

  view.innerHTML = `
    <div class="home-grid">
      <div class="home-left">
        <div id="install-slot"></div>
        <section class="hero-card ${negative ? "is-negative" : ""} ${revealed ? "" : "is-blurred"}" id="hero">
          <div class="hero-label">
            Free to spend
            <button class="hero-eye" id="eye-btn" aria-label="${revealed ? "Hide balances" : "Show balances"}" aria-pressed="${revealed}">
              ${eyeSVG(revealed)}
            </button>
          </div>
          <div class="hero-amount num">
            <span class="cur">${CURRENCY.symbol}</span>
            ${moneySpan(b.free)}
          </div>
          ${negative ? `<div class="hero-over-line">You're ${fmtMoney(-b.free)} over what you have.</div>` : ""}
          <div class="hero-sub">
            <div>
              <div class="sub-label"><span class="dot dot-total"></span> Total balance</div>
              <div class="sub-amount num">${moneySpan(b.total)}</div>
            </div>
            <div>
              <div class="sub-label"><span class="dot dot-committed"></span> Committed</div>
              <div class="sub-amount num">${moneySpan(b.committed)}</div>
            </div>
          </div>
        </section>
        <div id="acc-slot"></div>
      </div>

      <div class="home-right">
        <div id="expected-income-wrap"></div>
        <div class="section-head">
          <h2>Upcoming</h2>
          ${pending.length ? `<span class="count">${pending.length}</span>` : ""}
        </div>
        <div class="stack" id="upcoming"></div>
      </div>
    </div>
  `;

  // greeting
  const hello = $("#hello");
  if (hello) hello.textContent = greeting();

  // accounts row
  renderAccountsRow($("#acc-slot", view), { revealed });

  // eye toggle
  $("#eye-btn", view).addEventListener("click", (e) => {
    e.stopPropagation();
    revealed = !revealed;
    buzz(8);
    const hero = $("#hero", view);
    hero.classList.toggle("is-blurred", !revealed);
    const accRow = $(".acc-row", view);
    if (accRow) accRow.classList.toggle("is-blurred", !revealed);
    const btn = $("#eye-btn", view);
    btn.innerHTML = eyeSVG(revealed);
    btn.setAttribute("aria-pressed", String(revealed));
    btn.setAttribute("aria-label", revealed ? "Hide balances" : "Show balances");
    if (revealed && !hasCountedUp) {
      hasCountedUp = true;
      countUp(view);
    }
    if (!revealed) hideTip();
  });

  wireTips(view);

  // expected income — pending income, actionable ("Mark received"), separate from the Upcoming
  // expense list so that component's recurrence/series logic stays untouched.
  const pendingIncome = state.entries
    .filter((e) => e.kind === "income" && e.status === "pending")
    .sort((a, b) => (a.dueDate || "9999") < (b.dueDate || "9999") ? -1 : 1);
  const eiWrap = $("#expected-income-wrap", view);
  if (pendingIncome.length) {
    eiWrap.innerHTML = `
      <div class="section-head">
        <h2>Expected income</h2>
        <span class="count">${pendingIncome.length}</span>
      </div>
      <div class="stack" id="expected-income"></div>
    `;
    const eiList = $("#expected-income", view);
    for (const e of pendingIncome) eiList.append(incomeCard(e));
    anim([...eiList.children], { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, stagger: 0.07, delay: 0.1, ease: "power2.out" });
  }

  // upcoming cards
  const list = $("#upcoming", view);
  if (!pending.length) {
    list.append(renderEmpty());
  } else {
    for (const e of pending) list.append(expenseCard(e));
  }

  // entrance animation
  anim($("#hero", view), { y: 24, opacity: 0, scale: 0.97 }, { y: 0, opacity: 1, scale: 1, duration: 0.55, ease: "power3.out" });
  anim([...($(".acc-row", view)?.children || $("#acc-slot", view).children)], { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, stagger: 0.05, delay: 0.1, ease: "power2.out" });
  anim([...list.children], { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, stagger: 0.07, delay: 0.12, ease: "power2.out" });
}

function incomeCard(e) {
  const hint = e.dueDate ? dueHint(e.dueDate) : { text: "Expected", tone: "ok" };
  const overdue = hint.tone === "overdue";
  const card = el("div", { class: `card exp-card is-income ${overdue ? "is-overdue" : ""}`, "data-id": e.id });
  card.innerHTML = `
    <div class="spread">
      <div class="grow">
        <div class="exp-title truncate">${esc(e.title)}</div>
        <div class="exp-meta">
          <span class="due-hint ${hint.tone === "overdue" ? "is-overdue" : hint.tone === "soon" ? "is-soon" : ""}">${hint.text}</span>
          ${e.dueDate ? `<span>· ${shortDate(e.dueDate)}</span>` : ""}
        </div>
      </div>
      <div class="exp-amount num" style="color:var(--c-pos)">+${fmtMoney(e.amount)}</div>
    </div>
    <div class="exp-actions">
      <button class="chip-btn chip-paid" data-act="received">${icon("check", 15)} Mark received</button>
      <button class="chip-btn chip-edit" data-act="edit">Edit</button>
      <button class="chip-btn chip-delete" data-act="delete" aria-label="Delete">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
      </button>
    </div>
  `;

  card.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    buzz(10);

    if (act === "edit") { addMoneySheet(e); return; }

    if (act === "received") {
      await celebratePaid(card);
      await markPaid(e.id);
      toast(`${e.title} received · ${fmtMoney(e.amount)}`, {
        icon: icon("check-circle", 18),
        undo: async () => { await unmarkPaid(e.id); toast("Marked pending again"); },
      });
      return;
    }

    if (act === "delete") {
      const ok = await confirmSheet({
        title: "Delete pending income?",
        message: `"${e.title}" (${fmtMoney(e.amount)}) will be removed.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (ok) {
        const removed = await deleteEntry(e.id);
        toast("Deleted", { icon: icon("trash", 17), undo: () => restoreEntries([removed]) });
      }
    }
  });

  return card;
}

function renderEmpty() {
  return el("div", {
    class: "empty",
    html: `
      <div class="empty-ico">${icon("sun", 28)}</div>
      <h3>Nothing coming up</h3>
      <p>Add your first expense and Batwa will keep an eye on what's due.</p>
    `,
  });
}

function recBadge(rec) {
  if (rec === "weekly") return `<span class="badge badge-weekly">${icon("repeat", 11)} Weekly</span>`;
  if (rec === "monthly") return `<span class="badge badge-monthly">${icon("repeat", 11)} Monthly</span>`;
  return '<span class="badge badge-once">One-time</span>';
}

function expenseCard(e) {
  const hint = e.dueDate ? dueHint(e.dueDate) : { text: "No due date", tone: "ok" };
  const overdue = hint.tone === "overdue";
  const card = el("div", {
    class: `card exp-card ${overdue ? "is-overdue" : ""}`,
    "data-rec": e.recurrence,
    "data-id": e.id,
  });
  card.innerHTML = `
    <div class="spread">
      <div class="grow">
        <div class="exp-title truncate">${esc(e.title)}</div>
        <div class="exp-meta">
          <span class="due-hint ${hint.tone === "overdue" ? "is-overdue" : hint.tone === "soon" ? "is-soon" : ""}">${hint.text}</span>
          ${e.dueDate ? `<span>· ${shortDate(e.dueDate)}</span>` : ""}
        </div>
      </div>
      <div class="exp-amount num">${fmtMoney(e.amount)}</div>
    </div>
    <div class="exp-meta" style="margin-top:8px">
      ${recBadge(e.recurrence)}
      <span class="badge badge-cat">${catIcon(e.category, 12)} ${esc(e.category)}</span>
      ${e.accountId && accountName(e.accountId) ? `<span class="badge badge-cat">${esc(accountName(e.accountId))}</span>` : ""}
    </div>
    <div class="exp-actions">
      <button class="chip-btn chip-paid" data-act="paid">${icon("check", 15)} Mark paid</button>
      <button class="chip-btn chip-edit" data-act="edit">Edit</button>
      <button class="chip-btn chip-delete" data-act="delete" aria-label="Delete">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
      </button>
    </div>
  `;

  card.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    buzz(10);

    if (act === "edit") { addExpenseSheet(e); return; }

    if (act === "paid") {
      await celebratePaid(card);
      await markPaid(e.id);
      toast(`${e.title} paid · ${fmtMoney(e.amount)}`, {
        icon: icon("check-circle", 18),
        undo: async () => { await unmarkPaid(e.id); toast("Marked unpaid again"); },
      });
      return;
    }

    if (act === "delete") {
      if (e.recurrence !== "one-time" && e.seriesId) {
        const pick = await chooseSheet({
          title: "Delete recurring expense",
          message: `"${e.title}" repeats ${e.recurrence}. What should go?`,
          options: [
            { label: "Just this one", value: "one" },
            { label: "This and all future", value: "future", style: "btn-soft-danger" },
            { label: "Cancel", value: null, style: "btn-ghost" },
          ],
        });
        if (pick === "one") {
          const removed = await deleteEntry(e.id);
          toast("Deleted", { icon: icon("trash", 17), undo: () => restoreEntries([removed]) });
        } else if (pick === "future") {
          const removed = await deleteSeriesFuture(e.id);
          toast(`Deleted ${removed.length} upcoming`, { icon: icon("trash", 17), undo: () => restoreEntries(removed) });
        }
      } else {
        const ok = await confirmSheet({
          title: "Delete expense?",
          message: `"${e.title}" (${fmtMoney(e.amount)}) will be removed.`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (ok) {
          const removed = await deleteEntry(e.id);
          toast("Deleted", { icon: icon("trash", 17), undo: () => restoreEntries([removed]) });
        }
      }
    }
  });

  return card;
}

/** Mark-paid should feel good: green sweep + check pop, then the card folds away. */
function celebratePaid(card) {
  return new Promise((resolve) => {
    if (!motionOK()) return resolve();
    const check = el("div", {
      style: `position:absolute;inset:0;display:grid;place-items:center;
              background:linear-gradient(135deg,rgba(14,159,110,0.96),rgba(22,199,154,0.96));
              border-radius:inherit;z-index:2;color:#fff;`,
      html: '<svg width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="24" stroke="rgba(255,255,255,0.4)" stroke-width="3"/><path class="ck" d="M15 27l8 8 15-16" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    });
    card.style.position = "relative";
    card.append(check);
    const path = check.querySelector(".ck");
    const len = path.getTotalLength();
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    const tl = gsap.timeline({ onComplete: resolve });
    tl.fromTo(check, { opacity: 0 }, { opacity: 1, duration: 0.18 })
      .to(path, { strokeDashoffset: 0, duration: 0.35, ease: "power2.out" })
      .fromTo(check.querySelector("svg"), { scale: 0.7 }, { scale: 1, duration: 0.35, ease: "back.out(2.5)" }, "<")
      .to(card, { height: 0, marginBottom: -16, opacity: 0, paddingTop: 0, paddingBottom: 0, duration: 0.35, ease: "power2.in", delay: 0.35 });
  });
}
