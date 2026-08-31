// Accounts: logo pack, home account cards, add/manage sheets, Fix balance flow.

import { $, el, esc, anim, motionOK, buzz } from "../util/dom.js";
import { fmtMoney, fmtCompact, dueHint, shortDate } from "../util/format.js";
import { state, addAccount, updateAccount, removeAccountWithEntries, restoreAccountWithEntries, accountBalance, accountBreakdown, pendingExpenses, reconcileAccount, deleteEntry, reorderAccounts } from "../ledger.js";
import { openSheet, closeSheet, confirmSheet } from "./modals.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";

/* ============================================================
   Logo pack — real brand marks from branding/banks/ on clean white
   tiles, with the brand-colored glyph tile as an onerror-only fallback
   for a missing/broken asset (never painted behind a loaded logo).
   ============================================================ */

const LOGO_DIR = "branding/banks";

export const LOGO_KINDS = {
  // --- shown up front in the picker ---
  jazzcash:   { name: "JazzCash",          bg: "#E11931", glyph: "J", logo: "jazzcash" },
  easypaisa:  { name: "Easypaisa",         bg: "#43A833", glyph: "e", logo: "easypaisa" },
  nayapay:    { name: "NayaPay",           bg: "#00C4B3", glyph: "n", logo: "nayapay" },
  zindigi:    { name: "Zindigi",           bg: "#6A2C91", glyph: "Z", logo: "zindigi" },
  meezan:     { name: "Meezan Bank",       bg: "#084F2E", glyph: "M", logo: "meezan" },
  ubl:        { name: "UBL",               bg: "#007DC5", glyph: "U", logo: "ubl" },
  hbl:        { name: "HBL",               bg: "#009591", glyph: "H", logo: "hbl" },
  alfalah:    { name: "Bank Alfalah",      bg: "#8A1538", glyph: "A", logo: "alfalah" },
  mcb:        { name: "MCB",               bg: "#046A38", glyph: "M", logo: "mcb" },
  allied:     { name: "Allied Bank",       bg: "#00447C", glyph: "A", logo: "allied" },
  cash:       { name: "Cash",              bg: "#12B77F", ico: "banknote" },
  bank:       { name: "Other bank",        bg: "#64748B", ico: "landmark" },

  // --- behind "Other bank" ---
  sadapay:    { name: "SadaPay",           bg: "#FF5F96", glyph: "s", logo: "sadapay" },
  upaisa:     { name: "UPaisa",            bg: "#F7941E", glyph: "u", logo: "upaisa" },
  alhabib:    { name: "Bank Al Habib",     bg: "#14487F", glyph: "H", logo: "alhabib" },
  askari:     { name: "Askari Bank",       bg: "#00629B", glyph: "A", logo: "askari" },
  faysal:     { name: "Faysal Bank",       bg: "#00A19A", glyph: "F", logo: "faysal" },
  nbp:        { name: "National Bank",     bg: "#00693E", glyph: "N", logo: "nbp" },
  bop:        { name: "Bank of Punjab",    bg: "#056839", glyph: "B", logo: "bop" },
  habibmetro: { name: "HabibMetro",        bg: "#003A70", glyph: "H", logo: "habibmetro" },
  jsbank:     { name: "JS Bank",           bg: "#0090A8", glyph: "J", logo: "jsbank" },
  soneri:     { name: "Soneri Bank",       bg: "#FFC426", glyph: "S", logo: "soneri" },
  scb:        { name: "Standard Chartered", bg: "#0473EA", glyph: "S", logo: "scb" },
  dib:        { name: "Dubai Islamic",     bg: "#0B3B5C", glyph: "D", logo: "dib" },
  bankislami: { name: "BankIslami",        bg: "#007C7A", glyph: "B", logo: "bankislami" },
  albaraka:   { name: "Al Baraka",         bg: "#007A33", glyph: "A", logo: "albaraka" },
};

/** Picker layout: 12 tiles up front, everything else behind "Other bank". */
const PRIMARY_KINDS = [
  "jazzcash", "easypaisa", "nayapay", "zindigi",
  "meezan", "ubl", "hbl", "alfalah",
  "mcb", "allied", "cash", "bank",
];
const MORE_KINDS = [
  "sadapay", "upaisa", "alhabib", "askari", "faysal", "nbp", "bop",
  "habibmetro", "jsbank", "soneri", "scb", "dib", "bankislami", "albaraka",
];

export function logoTile(kind, size = 40) {
  const k = LOGO_KINDS[kind] || LOGO_KINDS.bank;
  const radius = Math.max(8, Math.round(size * 0.28));
  const box = `width:${size}px;height:${size}px;border-radius:${radius}px;--tile-bg:${k.bg};`;

  if (k.ico) {
    // Intentional icon tiles (cash, generic bank) — no logo file exists, so
    // they stay a colored tile with a white glyph icon.
    return `<span class="acc-logo acc-logo-ico" style="${box}" aria-hidden="true">${icon(k.ico, Math.round(size * 0.52))}</span>`;
  }

  if (k.logo) {
    // Clean white card: the mark sits centered in a fixed-size inner box so
    // every logo reads at the same optical size regardless of its own aspect
    // ratio. If the SVG ever 404s, onerror flips the tile into its fallback
    // state and the brand-colored glyph (pre-rendered, hidden by CSS) shows
    // through instead — the glyph never sits *behind* a loaded logo.
    const inner = Math.round(size * 0.66);
    const fs = Math.round(size * 0.34);
    return `<span class="acc-logo has-logo" style="${box}" aria-hidden="true">
      <span class="acc-logo-imgbox" style="width:${inner}px;height:${inner}px">
        <img src="${LOGO_DIR}/${k.logo}.svg" alt="" decoding="async" width="${inner}" height="${inner}"
          onerror="this.closest('.acc-logo').classList.add('is-fallback');this.parentElement.remove()">
      </span>
      <span class="acc-logo-glyph" style="font-size:${fs}px">${k.glyph || ""}</span>
    </span>`;
  }

  // No logo file and no icon (shouldn't happen for a known kind, but keeps
  // an unknown/legacy kind from rendering an empty tile).
  const fs = Math.round(size * 0.5);
  return `<span class="acc-logo is-fallback" style="${box}font-size:${fs}px" aria-hidden="true">${k.glyph || ""}</span>`;
}

export function accountName(id) {
  return state.accounts.find((a) => a.id === id)?.name || null;
}

/* ============================================================
   Home row: swipeable account cards
   ============================================================ */

/**
 * Bottom-up "bucket fill" fraction + color tone for the committed share of
 * a balance. Shared by the home cards and the account sheet so both read
 * the same at any percentage. Never NaN/Infinity.
 *   committed = 0               -> no fill, "normal" tone.
 *   raw = committed / balance   -> the underlying (possibly >1) ratio.
 *   pct                         -> raw capped to 1, for the fill height.
 *   tone: <80% "normal" (violet tint) · 80–90% "amber" · 90–100% "orange"
 *         · >=100% or balance <= 0 with committed > 0 -> "red".
 */
function fillFraction({ balance, committed }) {
  if (!committed) return { pct: 0, tone: "normal" };
  const raw = balance > 0 ? committed / balance : Infinity;
  const pct = Math.min(raw, 1);
  const tone = raw >= 1 ? "red" : raw >= 0.9 ? "orange" : raw >= 0.8 ? "amber" : "normal";
  return { pct, tone };
}

export function renderAccountsRow(container, { revealed }) {
  container.innerHTML = "";
  if (!state.accounts.length) {
    // opt-in feature: a quiet inline invite instead of an empty row
    const invite = el("button", { class: "acc-invite", onclick: addAccountSheet });
    invite.innerHTML = `<span class="acc-logo" style="width:34px;height:34px;background:var(--c-violet-soft);color:var(--c-violet)">${icon("plus", 17)}</span>
      <span class="small strong">Add your accounts</span>
      <span class="xsmall muted">JazzCash, bank, cash — see each balance</span>`;
    container.append(invite);
    return;
  }
  const row = el("div", { class: `acc-row ${revealed ? "" : "is-blurred"}` });
  const fills = []; // { el, pct } — animated after mount
  for (const acc of state.accounts) {
    const { balance: bal, committed } = accountBreakdown(acc.id);
    const { pct, tone } = fillFraction({ balance: bal, committed });
    const card = el("button", {
      class: "card acc-card", "data-id": acc.id,
      onclick: () => accountSheet(acc),
    });
    card.innerHTML = `
      <span class="acc-fill${tone !== "normal" ? ` is-${tone}` : ""}"></span>
      <span class="acc-card-inner">
        ${logoTile(acc.kind, 38)}
        <span class="acc-name truncate">${esc(acc.name)}</span>
        <span class="acc-bal money num blurable ${bal < 0 ? "is-neg" : ""}" data-tip="${fmtMoney(bal)}" data-tip-id="acc-${acc.id}" data-value="${bal}">${fmtCompact(bal)}</span>
      </span>
    `;
    row.append(card);
    if (pct > 0) fills.push({ el: card.querySelector(".acc-fill"), pct });
  }
  const add = el("button", { class: "acc-card acc-add", "aria-label": "Add account", onclick: addAccountSheet });
  add.innerHTML = `<span class="acc-logo" style="width:38px;height:38px;background:var(--c-bg-deep);color:var(--c-violet)">${icon("plus", 18)}</span><span class="acc-name muted">Add</span>`;
  row.append(add);
  container.append(row);

  // Bucket fills rise from empty to their level, staggered card to card.
  fills.forEach(({ el: fillNode, pct: p }, i) =>
    anim(fillNode, { height: "0%" }, { height: `${(p * 100).toFixed(2)}%`, duration: 0.7, delay: i * 0.05, ease: "power3.out" }));
}

/* ============================================================
   Sheets
   ============================================================ */

const reveal = (node) =>
  anim(node, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.22, ease: "power2.out" });

function logoGrid(selected, onPick) {
  const wrap = el("div", { class: "logo-picker" });
  let sel = selected;

  const opt = (kind, { label, backAfterPick = false } = {}) => {
    const k = LOGO_KINDS[kind];
    const b = el("button", {
      type: "button",
      class: `logo-opt ${kind === sel ? "is-active" : ""}`,
      "data-kind": kind,
      "aria-label": k.name,
      onclick: () => {
        sel = kind;
        buzz(6);
        onPick(kind);
        if (backAfterPick) renderPrimary();
        else [...wrap.querySelectorAll(".logo-opt")]
          .forEach((c) => c.classList.toggle("is-active", c.dataset.kind === sel));
      },
    });
    b.innerHTML = `${logoTile(kind, 42)}<span class="xsmall truncate">${esc(label || k.name)}</span>`;
    return b;
  };

  function renderPrimary() {
    wrap.innerHTML = "";
    const grid = el("div", { class: "logo-grid" });
    for (const kind of PRIMARY_KINDS) {
      if (kind !== "bank") { grid.append(opt(kind)); continue; }
      // "Other bank" opens the long list — and mirrors whatever was picked there
      const picked = MORE_KINDS.includes(sel) ? sel : null;
      const b = el("button", {
        type: "button",
        class: `logo-opt ${picked || sel === "bank" ? "is-active" : ""}`,
        "data-kind": "bank",
        "aria-label": "Other bank — see all banks",
        onclick: () => { buzz(6); renderMore(); },
      });
      b.innerHTML = `${logoTile(picked || "bank", 42)}
        <span class="xsmall truncate">${esc(picked ? LOGO_KINDS[picked].name : "Other bank")} ›</span>`;
      grid.append(b);
    }
    wrap.append(grid);
    reveal(grid);
  }

  function renderMore() {
    wrap.innerHTML = "";
    const back = el("button", {
      type: "button", class: "logo-back",
      onclick: () => { buzz(6); renderPrimary(); },
    });
    back.innerHTML = `<span class="logo-back-chev">‹</span><span>All banks &amp; wallets</span>`;
    const grid = el("div", { class: "logo-grid" });
    for (const kind of MORE_KINDS) grid.append(opt(kind, { backAfterPick: true }));
    grid.append(opt("bank", { label: "Not listed", backAfterPick: true }));
    wrap.append(back, grid);
    reveal(grid);
  }

  renderPrimary();
  return wrap;
}

export function addAccountSheet() {
  openSheet("Add account", (body) => {
    let kind = "jazzcash";
    const name = el("input", { class: "input", type: "text", placeholder: "Account name", value: LOGO_KINDS[kind].name, maxlength: "24" });
    let touched = false;
    name.addEventListener("input", () => (touched = true));
    const grid = logoGrid(kind, (k) => {
      kind = k;
      if (!touched) name.value = LOGO_KINDS[k].name;
    });
    const bal = el("input", { class: "input input-amount", type: "text", inputmode: "decimal", placeholder: "0" });
    const balWrap = el("div", { class: "input-amount-wrap" }, el("span", { class: "cur-prefix" }, "Rs"), bal);

    body.append(
      el("div", { class: "field" }, el("label", {}, "Service / bank"), grid),
      el("div", { class: "field" }, el("label", {}, "Name"), name),
      el("div", { class: "field" }, el("label", {}, "Current balance (optional)"), balWrap,
        el("p", { class: "xsmall muted", style: "margin-top:6px" }, "Recorded as a “Starting balance” entry so the account matches reality from day one.")),
      el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => closeSheet() }, "Cancel"),
        el("button", {
          class: "btn btn-primary",
          onclick: async () => {
            const n = name.value.trim();
            if (!n) { name.focus(); return; }
            const start = parseFloat(String(bal.value).replace(/[, ]/g, "")) || 0;
            await addAccount(n, kind, start > 0 ? start : 0);
            closeSheet();
            toast(`${n} added`, { icon: icon("check-circle", 18) });
          },
        }, "Add account"),
      ),
    );
  });
}

export function accountSheet(acc) {
  openSheet(acc.name, (body) => {
    const { balance: bal, committed, usable } = accountBreakdown(acc.id);
    const { pct, tone } = fillFraction({ balance: bal, committed });

    // --- The sheet itself IS the bucket: the tint fill is painted as the
    // .sheet element's own background (rises bottom-up, sits behind every
    // child, and — since .sheet is the overflow-y:auto scroll container —
    // stays put as content scrolls instead of scrolling away with it).
    // `body` is already appended into the sheet by openSheet() before this
    // builder runs, so its parent IS the live .sheet node.
    const sheetEl = body.closest(".sheet");
    sheetEl.classList.add("acc-sheet");
    if (tone !== "normal") sheetEl.classList.add(`is-${tone}`);
    sheetEl.style.setProperty("--fill-pct", "0%");

    const head = el("div", { class: "acc-sheet-head" });
    head.innerHTML = `
      ${logoTile(acc.kind, 44)}
      <div class="acc-sheet-head-text">
        <span class="acc-wash-name truncate">${esc(acc.name)}</span>
        <span class="acc-fill-cap xsmall muted">${committed > 0
          ? `${Math.round(pct * 100)}% of balance committed${tone === "red" ? " — over-committed" : ""}`
          : "Nothing committed yet"}</span>
      </div>
    `;
    body.append(head);

    // Rise-from-bottom: tween a plain proxy number and write it to the
    // --fill-pct custom prop each frame (cheap — one style write, no
    // layout), same pattern as the home hero's count-up. Runs fresh every
    // time the sheet opens (accountSheet() always builds a new sheetEl), so
    // the level is always seen rising from empty. Skips straight to the end
    // state under prefers-reduced-motion.
    if (pct > 0) {
      if (motionOK()) {
        const p = { v: 0 };
        gsap.to(p, {
          v: pct * 100, duration: 0.5, ease: "power2.out",
          onUpdate: () => sheetEl.style.setProperty("--fill-pct", `${p.v.toFixed(2)}%`),
        });
      } else {
        sheetEl.style.setProperty("--fill-pct", `${(pct * 100).toFixed(2)}%`);
      }
    }

    // --- Three figures: total / committed / usable ---
    const figures = el("div", { class: "acc-figures" });
    figures.innerHTML = `
      <div class="acc-figure-main">
        <div class="xsmall muted" style="text-transform:uppercase;letter-spacing:0.06em;font-weight:700">Total balance</div>
        <div class="num" style="font-size:1.9rem;font-weight:800;letter-spacing:-0.02em;${bal < 0 ? "color:var(--c-neg)" : ""}">${fmtMoney(bal)}</div>
      </div>
      <div class="acc-figure-row">
        <div class="acc-figure">
          <div class="xsmall muted">Committed</div>
          <div class="num strong" style="color:var(--c-warn)">${fmtMoney(committed)}</div>
        </div>
        <div class="acc-figure">
          <div class="xsmall muted">Usable</div>
          <div class="num strong" style="${usable < 0 ? "color:var(--c-neg)" : "color:var(--c-pos)"}">${fmtMoney(usable)}</div>
        </div>
      </div>
    `;
    body.append(figures);

    // --- What's committed: this account's pending expenses ---
    const pend = pendingExpenses().filter((e) => e.accountId === acc.id);
    const pendField = el("div", { class: "field" });
    pendField.append(el("label", {}, "Committed to"));
    if (!pend.length) {
      pendField.append(el("p", { class: "muted small", style: "margin:0" }, "No pending expenses on this account."));
    } else {
      const list = el("div", { class: "acc-pend-list" });
      for (const e of pend) {
        const hint = e.dueDate ? dueHint(e.dueDate) : { text: "No due date", tone: "ok" };
        const row = el("div", { class: "acc-pend-row" });
        row.innerHTML = `
          <div class="grow">
            <div class="exp-title truncate">${esc(e.title)}</div>
            <div class="due-hint xsmall ${hint.tone === "overdue" ? "is-overdue" : hint.tone === "soon" ? "is-soon" : ""}">${esc(hint.text)}${e.dueDate ? ` · ${shortDate(e.dueDate)}` : ""}</div>
          </div>
          <div class="exp-amount num">${fmtMoney(e.amount)}</div>
        `;
        list.append(row);
      }
      pendField.append(list);
    }
    body.append(pendField);

    // --- Fix balance ---
    const fix = el("input", { class: "input input-amount", type: "text", inputmode: "decimal", placeholder: fmtCompact(Math.max(bal, 0)) });
    const fixWrap = el("div", { class: "input-amount-wrap" }, el("span", { class: "cur-prefix" }, "Rs"), fix);
    const hint = el("p", { class: "xsmall muted", style: "margin-top:6px" }, "Missed some expenses? Enter what this account really has — the difference is saved as a “Balance fix” entry.");
    fix.addEventListener("input", () => {
      const v = parseFloat(String(fix.value).replace(/[, ]/g, ""));
      if (!isFinite(v)) { hint.textContent = "Missed some expenses? Enter what this account really has — the difference is saved as a “Balance fix” entry."; hint.style.color = ""; return; }
      const diff = Math.round((v - bal) * 100) / 100;
      if (!diff) { hint.textContent = "Already matching — nothing to fix."; hint.style.color = ""; }
      else {
        hint.textContent = diff < 0
          ? `Will record ${fmtMoney(-diff)} OUT as “Balance fix”`
          : `Will record ${fmtMoney(diff)} IN as “Balance fix”`;
        hint.style.color = diff < 0 ? "var(--c-neg)" : "var(--c-pos)";
      }
    });
    body.append(
      el("div", { class: "field", style: "margin-top:4px" },
        el("label", {}, "Fix balance — what does it actually have?"), fixWrap, hint),
      el("button", {
        class: "btn btn-primary btn-block", style: "margin-bottom:20px",
        onclick: async () => {
          const v = parseFloat(String(fix.value).replace(/[, ]/g, ""));
          if (!isFinite(v) || v < 0) { fix.focus(); return; }
          const entry = await reconcileAccount(acc.id, v);
          closeSheet();
          if (!entry) { toast("Balance already matches", { icon: icon("check-circle", 18) }); return; }
          toast(`Balance fixed · ${entry.kind === "expense" ? "−" : "+"}${fmtMoney(entry.amount)}`, {
            icon: icon("scale", 18),
            undo: async () => { await deleteEntry(entry.id); toast("Fix undone"); },
          });
        },
        html: `${icon("scale", 17)} Fix balance`,
      }),
    );

    // --- Rename / change logo / delete ---
    body.append(el("div", { class: "form-actions", style: "margin-top:0" },
      el("button", { class: "btn btn-ghost", onclick: () => editAccountSheet(acc) }, "Edit"),
      el("button", {
        class: "btn btn-soft-danger",
        onclick: async () => {
          const entries = state.entries.filter((e) => e.accountId === acc.id || e.fromAccountId === acc.id || e.toAccountId === acc.id);
          const pendingCount = entries.filter((e) => e.kind === "expense" && e.status === "pending").length;
          const { title, message } = removeAccountCopy(acc.name, bal, entries.length, pendingCount);
          const ok = await confirmSheet({ title, message, confirmLabel: "Remove", danger: true });
          if (!ok) return;
          const removed = await removeAccountWithEntries(acc.id);
          toast("Account removed", {
            icon: icon("trash", 17),
            undo: async () => { await restoreAccountWithEntries(removed); toast(`${acc.name} restored`); },
          });
        },
      }, "Remove"),
    ));
  });
}

/**
 * Impact copy for the remove-account confirm sheet — states the exact
 * rupee/transaction effect BEFORE the user confirms, since removal now takes
 * every entry tied to the account with it (see removeAccountWithEntries).
 */
function removeAccountCopy(name, bal, totalCount, pendingCount) {
  const title = `Remove ${name}?`;
  if (!totalCount) return { title, message: "It has no transactions." };

  const txWord = totalCount === 1 ? "transaction" : "transactions";
  const pendingClause = pendingCount > 0 ? ` (including ${pendingCount} upcoming)` : "";
  const txClause = `its ${totalCount} ${txWord}${pendingClause} will be deleted`;

  if (bal > 0) return { title, message: `Its ${fmtMoney(bal)} will be subtracted from your total balance, and ${txClause}.` };
  if (bal < 0) return { title, message: `Your total balance will increase by ${fmtMoney(-bal)} — this account was negative — and ${txClause}.` };
  return { title, message: `Its balance is already zero, but ${txClause}.` };
}

function editAccountSheet(acc) {
  openSheet("Edit account", (body) => {
    let kind = acc.kind;
    const name = el("input", { class: "input", type: "text", value: acc.name, maxlength: "24" });
    body.append(
      el("div", { class: "field" }, el("label", {}, "Service / bank"), logoGrid(kind, (k) => (kind = k))),
      el("div", { class: "field" }, el("label", {}, "Name"), name),
      el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: () => closeSheet() }, "Cancel"),
        el("button", {
          class: "btn btn-primary",
          onclick: async () => {
            if (!name.value.trim()) { name.focus(); return; }
            await updateAccount(acc.id, { name: name.value.trim(), kind });
            closeSheet();
            toast("Account updated", { icon: icon("check-circle", 18) });
          },
        }, "Save"),
      ),
    );
  });
}

/** Settings entry point: manage the whole list — drag the handle to reorder; the order here IS Home's order. */
export function manageAccountsSheet() {
  openSheet("Accounts", (body) => {
    if (!state.accounts.length) {
      body.append(el("p", { class: "muted small", style: "margin-bottom:14px" },
        "No accounts yet. Add JazzCash, banks, or cash to see where your money actually sits."));
    } else {
      const draggable = state.accounts.length > 1;
      if (draggable) body.append(el("p", { class: "xsmall muted", style: "margin:0 0 8px" }, "Drag to reorder — the top account shows first on Home."));
      const list = el("div", { class: "stack acc-reorder-list", style: "margin-bottom:16px" });
      for (const acc of state.accounts) {
        const tap = el("button", { class: "acc-reorder-tap", onclick: () => accountSheet(acc) });
        tap.innerHTML = `${logoTile(acc.kind, 36)}<span class="grow truncate" style="text-align:left">${esc(acc.name)}</span>
          <span class="num strong">${fmtCompact(accountBalance(acc.id))}</span><span class="chev">›</span>`;
        const r = el("div", { class: "set-row card acc-reorder-row", "data-id": acc.id }, tap);
        if (draggable) {
          const handle = el("button", { type: "button", class: "drag-handle", "aria-label": `Reorder ${esc(acc.name)}`, html: icon("grip", 18) });
          r.prepend(handle);
          wireAccountDrag(handle, r, list);
        }
        list.append(r);
      }
      body.append(list);
    }
    body.append(el("button", { class: "btn btn-primary btn-block", onclick: addAccountSheet }, "＋ Add account"));
  });
}

/**
 * Vertical drag-to-reorder on the handle only. Every pointer event calls
 * stopPropagation — the sheet itself also listens for vertical pointer drags
 * (its own swipe-to-dismiss, wired in modals.js) and would otherwise treat
 * this same gesture as a dismiss attempt.
 * Uses translateY relative to the ORIGINAL pointerdown position, with a
 * running `layoutShift` correction applied every time the dragged row's DOM
 * position swaps with a neighbor — this keeps the row visually glued to the
 * pointer across swaps instead of jumping.
 */
function wireAccountDrag(handle, row, list) {
  let dragging = false, pointerId = null, startY = 0, layoutShift = 0;

  const setY = (y) => {
    if (typeof gsap !== "undefined") gsap.set(row, { y });
    else row.style.transform = y ? `translateY(${y}px)` : "";
  };

  function onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    dragging = true;
    pointerId = e.pointerId;
    startY = e.clientY;
    layoutShift = 0;
    try { handle.setPointerCapture(pointerId); } catch {}
    row.classList.add("is-dragging");
    buzz(10);
  }

  function onMove(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();

    const rowH = row.offsetHeight;
    let guard = 0;
    while (guard++ < 12) {
      const dyNow = (e.clientY - startY) - layoutShift;
      const rows = [...list.children];
      const idx = rows.indexOf(row);
      const prev = rows[idx - 1];
      const next = rows[idx + 1];
      if (prev && row.offsetTop + dyNow < prev.offsetTop + prev.offsetHeight / 2 - rowH / 2) {
        const beforeTop = row.offsetTop;
        list.insertBefore(row, prev);
        layoutShift += row.offsetTop - beforeTop;
        buzz(6);
        continue;
      }
      if (next && row.offsetTop + dyNow > next.offsetTop + next.offsetHeight / 2 - rowH / 2) {
        const beforeTop = row.offsetTop;
        list.insertBefore(row, next.nextSibling);
        layoutShift += row.offsetTop - beforeTop;
        buzz(6);
        continue;
      }
      break;
    }
    setY((e.clientY - startY) - layoutShift);
  }

  function onUp(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    e.stopPropagation();
    dragging = false;
    try { handle.releasePointerCapture(pointerId); } catch {}
    row.classList.remove("is-dragging");
    if (motionOK()) gsap.to(row, { y: 0, duration: 0.25, ease: "power2.out" });
    else setY(0);
    reorderAccounts([...list.children].map((r) => r.dataset.id));
  }

  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}
