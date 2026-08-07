// Accounts: logo pack, home account cards, add/manage sheets, Fix balance flow.

import { $, el, esc, anim, buzz } from "../util/dom.js";
import { fmtMoney, fmtCompact } from "../util/format.js";
import { state, addAccount, updateAccount, deleteAccount, accountBalance, reconcileAccount, deleteEntry } from "../ledger.js";
import { openSheet, closeSheet, confirmSheet } from "./modals.js";
import { toast } from "./toast.js";

/* ============================================================
   Logo pack — simplified brand-colored marks (offline, no assets)
   ============================================================ */

export const LOGO_KINDS = {
  jazzcash:  { name: "JazzCash",     bg: "#E11931", glyph: "J" },
  easypaisa: { name: "Easypaisa",    bg: "#43A833", glyph: "e" },
  nayapay:   { name: "NayaPay",      bg: "#00C4B3", glyph: "n" },
  sadapay:   { name: "SadaPay",      bg: "#FF5F96", glyph: "s" },
  upaisa:    { name: "UPaisa",       bg: "#F7941E", glyph: "u" },
  meezan:    { name: "Meezan Bank",  bg: "#084F2E", glyph: "M" },
  ubl:       { name: "UBL",          bg: "#005EAA", glyph: "U" },
  hbl:       { name: "HBL",          bg: "#00874E", glyph: "H" },
  alfalah:   { name: "Bank Alfalah", bg: "#8A1538", glyph: "A" },
  mcb:       { name: "MCB",          bg: "#046A38", glyph: "M" },
  bank:      { name: "Other bank",   bg: "#64748B", glyph: "🏛" },
  cash:      { name: "Cash",         bg: "#12B77F", glyph: "₨" },
};

export function logoTile(kind, size = 40) {
  const k = LOGO_KINDS[kind] || LOGO_KINDS.bank;
  const fs = k.glyph.length > 1 ? size * 0.38 : size * 0.5;
  return `<span class="acc-logo" style="width:${size}px;height:${size}px;background:${k.bg};font-size:${fs}px" aria-hidden="true">${k.glyph}</span>`;
}

export function accountName(id) {
  return state.accounts.find((a) => a.id === id)?.name || null;
}

/* ============================================================
   Home row: swipeable account cards
   ============================================================ */

export function renderAccountsRow(container, { revealed }) {
  container.innerHTML = "";
  if (!state.accounts.length) {
    // opt-in feature: a quiet inline invite instead of an empty row
    const invite = el("button", { class: "acc-invite", onclick: addAccountSheet });
    invite.innerHTML = `<span class="acc-logo" style="width:34px;height:34px;background:var(--c-violet-soft);color:var(--c-violet);font-size:18px">＋</span>
      <span class="small strong">Add your accounts</span>
      <span class="xsmall muted">JazzCash, bank, cash — see each balance</span>`;
    container.append(invite);
    return;
  }
  const row = el("div", { class: `acc-row ${revealed ? "" : "is-blurred"}` });
  for (const acc of state.accounts) {
    const bal = accountBalance(acc.id);
    const card = el("button", { class: "card acc-card", "data-id": acc.id, onclick: () => accountSheet(acc) });
    card.innerHTML = `
      ${logoTile(acc.kind, 38)}
      <span class="acc-name truncate">${esc(acc.name)}</span>
      <span class="acc-bal money num blurable ${bal < 0 ? "is-neg" : ""}" data-tip="${fmtMoney(bal)}" data-tip-id="acc-${acc.id}" data-value="${bal}">${fmtCompact(bal)}</span>
    `;
    row.append(card);
  }
  const add = el("button", { class: "acc-card acc-add", "aria-label": "Add account", onclick: addAccountSheet });
  add.innerHTML = `<span class="acc-logo" style="width:38px;height:38px;background:var(--c-bg-deep);color:var(--c-violet);font-size:20px">＋</span><span class="acc-name muted">Add</span>`;
  row.append(add);
  container.append(row);
}

/* ============================================================
   Sheets
   ============================================================ */

function logoGrid(selected, onPick) {
  const grid = el("div", { class: "logo-grid" });
  for (const [kind, k] of Object.entries(LOGO_KINDS)) {
    const b = el("button", {
      type: "button",
      class: `logo-opt ${kind === selected ? "is-active" : ""}`,
      "aria-label": k.name,
      onclick: () => {
        [...grid.children].forEach((c) => c.classList.remove("is-active"));
        b.classList.add("is-active");
        buzz(6);
        onPick(kind);
      },
    });
    b.innerHTML = `${logoTile(kind, 42)}<span class="xsmall truncate">${k.name}</span>`;
    grid.append(b);
  }
  return grid;
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
            toast(`${n} added`, { icon: "✅" });
          },
        }, "Add account"),
      ),
    );
  });
}

export function accountSheet(acc) {
  openSheet(acc.name, (body) => {
    const bal = accountBalance(acc.id);
    body.append(el("div", { class: "acc-hero", html: `
      ${logoTile(acc.kind, 52)}
      <div>
        <div class="xsmall muted" style="text-transform:uppercase;letter-spacing:0.06em;font-weight:700">Balance</div>
        <div class="num" style="font-size:1.9rem;font-weight:800;letter-spacing:-0.02em;${bal < 0 ? "color:var(--c-neg)" : ""}">${fmtMoney(bal)}</div>
      </div>
    ` }));

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
          if (!entry) { toast("Balance already matches", { icon: "👌" }); return; }
          toast(`Balance fixed · ${entry.kind === "expense" ? "−" : "+"}${fmtMoney(entry.amount)}`, {
            icon: "⚖️",
            undo: async () => { await deleteEntry(entry.id); toast("Fix undone"); },
          });
        },
      }, "⚖️ Fix balance"),
    );

    // --- Rename / change logo / delete ---
    body.append(el("div", { class: "form-actions", style: "margin-top:0" },
      el("button", { class: "btn btn-ghost", onclick: () => editAccountSheet(acc) }, "Edit"),
      el("button", {
        class: "btn btn-soft-danger",
        onclick: async () => {
          const ok = await confirmSheet({
            title: "Remove account?",
            message: `"${acc.name}" will be removed. Its entries stay in your history, just no longer tied to an account.`,
            confirmLabel: "Remove",
            danger: true,
          });
          if (ok) { await deleteAccount(acc.id); toast("Account removed", { icon: "🗑️" }); }
        },
      }, "Remove"),
    ));
  });
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
            toast("Account updated", { icon: "✅" });
          },
        }, "Save"),
      ),
    );
  });
}

/** Settings entry point: manage the whole list. */
export function manageAccountsSheet() {
  openSheet("Accounts", (body) => {
    if (!state.accounts.length) {
      body.append(el("p", { class: "muted small", style: "margin-bottom:14px" },
        "No accounts yet. Add JazzCash, banks, or cash to see where your money actually sits."));
    } else {
      const list = el("div", { class: "stack", style: "margin-bottom:16px" });
      for (const acc of state.accounts) {
        const r = el("button", {
          class: "set-row card", style: "border-radius:16px",
          onclick: () => accountSheet(acc),
        });
        r.innerHTML = `${logoTile(acc.kind, 36)}<span class="grow truncate" style="text-align:left">${esc(acc.name)}</span>
          <span class="num strong">${fmtCompact(accountBalance(acc.id))}</span><span class="chev">›</span>`;
        list.append(r);
      }
      body.append(list);
    }
    body.append(el("button", { class: "btn btn-primary btn-block", onclick: addAccountSheet }, "＋ Add account"));
  });
}
