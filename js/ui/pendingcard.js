// The accept card: one shared entry, everything I need to answer it, and the
// three answers. Used in three places without a single fork — the pending
// sheet, the space screen's "Pending for you", and (in its waiting variant)
// "Waiting on others".
//
// It never opens a sheet of its own. Edit and Reject are INLINE panels inside
// the card, the same rule js/ui/catedit.js set: sheets cannot nest, so a step
// inside a flow repaints the surface it is already on. The category "+" is the
// one exception, and only because it mounts its own fixed layer above
// everything rather than a second sheet.
//
// Answering redraws the card and emits silently. The page underneath — Home,
// the space screen, a half-scrolled History — is never re-rendered (§9.29).

import { el, esc, anim, buzz, segmented } from "../util/dom.js";
import { state } from "../ledger.js";
import { fmtMoney, agoLabel, shortDate } from "../util/format.js";
import { icon, catIcon } from "./icons.js";
import { logoTile } from "./accounts.js";
import { categoryField } from "./catedit.js";
import { toast } from "./toast.js";
import { openSheet, closeSheet } from "./modals.js";
import {
  getSpace, membersOf, sharedEntry, myShareOf, colorHex, MEMBER_COLORS, initialsOf,
  acceptShared, rejectShared, editShared, resolveUnassigned, unassignedOf,
  splitEqually, allPending, pendingForMe, removeShared,
  acceptSettlement, rejectSettlement,
} from "../spaces.js";
import { rowsForShared } from "../ledger.js";

const REJECT_REASONS = ["Not mine", "Wrong amount", "Other"];

const memberOf = (space, id) => membersOf(space.id).find((m) => m.memberId === id) || null;
const nameOf = (space, id) =>
  id === space.myMemberId ? "You" : (memberOf(space, id)?.name || "Someone");

/** The little coloured initials disc every row here starts with. */
function avatar(space, id, size = 30) {
  const m = memberOf(space, id);
  return el("span", {
    class: "sp-av",
    style: `width:${size}px;height:${size}px;font-size:${size < 26 ? 9 : 11}px;background:${colorHex(m?.color, MEMBER_COLORS)}`,
  }, initialsOf(m?.name || "?"));
}

/** "3 ways · Faraz paid" */
function splitLine(space, entry) {
  const ways = Object.keys(entry.split?.shares || {}).length;
  return `${ways} way${ways === 1 ? "" : "s"} · ${nameOf(space, entry.paidBy)} paid`;
}

/** The category to file this under: the proposer's if I have it, else Others. */
function prefilledCategory(space, entry) {
  if (entry.category && state.categories.includes(entry.category)) return entry.category;
  if (space.lastCategory && state.categories.includes(space.lastCategory)) return space.lastCategory;
  return "Others";
}

/** Account chips, prefilled from what I picked last time in this space. */
function accountRow(space, label = "Which account?") {
  let picked = state.accounts.some((a) => a.id === space.lastAccountId) ? space.lastAccountId : null;
  const row = el("div", { class: "filter-row", style: "margin:0" });
  const mk = (id, label, logo = "") => {
    const b = el("button", { type: "button", class: `acc-chip ${picked === id ? "is-active" : ""}` });
    b.innerHTML = `${logo}<span>${esc(label)}</span>`;
    b.addEventListener("click", () => {
      picked = id;
      buzz(6);
      [...row.children].forEach((c) => c.classList.remove("is-active"));
      b.classList.add("is-active");
    });
    return b;
  };
  for (const a of state.accounts) row.append(mk(a.id, a.name, logoTile(a.kind, 22)));
  row.append(mk(null, "No account"));
  const field = el("div", { class: "field" }, el("label", {}, label), row);
  return { field: state.accounts.length ? field : null, get: () => picked };
}

/* ============================================================
   The card
   ============================================================ */

/**
 * `entry` may be stale by the time a button is pressed — a pull could have
 * landed — so every action re-reads it from the blob first. `onResolved` fires
 * once the entry no longer needs me.
 */
export function pendingCard(spaceId, entryId, { onResolved = null, compact = false } = {}) {
  const card = el("div", { class: `pend-card ${compact ? "is-compact" : ""}` });
  paint();
  return card;

  function paint() {
    const space = getSpace(spaceId);
    const entry = sharedEntry(spaceId, entryId);
    card.innerHTML = "";
    if (!space || !entry) { card.remove(); onResolved && onResolved(); return; }

    // Money somebody says they sent me is a different question from a split:
    // there is nothing to categorise and nothing to agree to, only "did it
    // arrive, and where" (plan §5.3, §6).
    if (entry.kind === "settlement") return paintSettlement(space, entry);

    const share = myShareOf(entry, space);
    const prior = rowsForShared(spaceId, entryId)[0] || null;

    /* ---- header ---- */
    const head = el("div", { class: "pend-head" });
    head.append(avatar(space, entry.proposedBy));
    head.append(el("span", { class: "grow" },
      el("span", { class: "strong small", style: "display:block" },
        `${nameOf(space, entry.proposedBy)} added`),
      el("span", { class: "xsmall muted" },
        `${agoLabel(entry.updatedAt || entry.createdAt)} · ${space.name}`)));
    head.append(el("span", { class: "pend-space-dot", style: `background:${colorHex(space.color)}` }));
    card.append(head);

    /* ---- what it is ---- */
    card.append(el("div", { class: "pend-title" },
      el("span", { class: "pend-cat", html: catIcon(entry.category, 17) }),
      el("span", { class: "truncate" }, entry.title || "Untitled")));
    card.append(el("p", { class: "pend-sub xsmall muted" },
      `${fmtMoney(entry.amount)} · ${splitLine(space, entry)} · ${shortDate(entry.date)}`));

    // Plan §9.9: the numbers moved after I had already written a row for this.
    // Say exactly what changed — the total if that is what moved, otherwise my
    // own share, which is what a re-split leaves different while the total sits
    // still. Never "something changed": the figures are the whole point.
    if (prior) {
      const oldTotal = Number(prior.sharedTotal) || 0;
      const oldShare = Number(prior.amount) || 0;
      const who = esc(nameOf(space, entry.updatedBy || entry.proposedBy));
      const what = esc(entry.title || "this");
      const line = oldTotal && oldTotal !== Number(entry.amount)
        ? `${who} changed ${what} from ${fmtMoney(oldTotal)} to ${fmtMoney(entry.amount)}`
        : oldShare !== share
          ? `${who} changed your share of ${what} from ${fmtMoney(oldShare)} to ${fmtMoney(share)}`
          : null;
      if (line) {
        card.append(el("p", {
          class: "pend-changed",
          html: `${icon("alert", 14)} <span>${line}</span>`,
        }));
      }
    }

    card.append(el("div", { class: "pend-share" },
      el("span", { class: "pend-share-label" }, "Your share"),
      el("span", { class: "pend-share-amt num" }, fmtMoney(share))));

    /* ---- my side ---- */
    const { field: catF, select: cat } = categoryField(prefilledCategory(space, entry));
    card.append(catF);
    const acc = accountRow(space);
    if (acc.field) card.append(acc.field);
    const note = el("textarea", { class: "input", rows: "2", placeholder: "Note (optional)" });
    note.value = prior?.note || "";
    card.append(el("div", { class: "field" }, el("label", {}, "Note"), note));

    /* ---- actions ---- */
    const panel = el("div", { class: "pend-panel", hidden: true });
    const actions = el("div", { class: "pend-actions" });
    const accept = el("button", { type: "button", class: "btn btn-primary" }, "Accept");
    const edit = el("button", { type: "button", class: "btn btn-ghost" }, "Edit");
    const reject = el("button", { type: "button", class: "btn btn-soft-danger" }, "Reject");
    actions.append(accept, edit, reject);
    card.append(actions, panel);

    accept.addEventListener("click", async () => {
      buzz(12);
      accept.disabled = edit.disabled = reject.disabled = true;
      await acceptShared(spaceId, entryId, {
        accountId: acc.get(), category: cat.value, note: note.value.trim(),
      });
      toast(`${fmtMoney(share)} added to your ledger`, { icon: icon("check-circle", 18) });
      done();
    });

    edit.addEventListener("click", () => {
      buzz(8);
      if (!panel.hidden && panel.dataset.mode === "edit") { hidePanel(); return; }
      panel.dataset.mode = "edit";
      showPanel(editPanel(space, entry, {
        onCancel: hidePanel,
        onSave: async ({ amount, shares, mode }) => {
          await editShared(spaceId, entryId, {
            amount, shares, mode,
            accountId: acc.get(), category: cat.value, note: note.value.trim(),
          });
          toast("Re-proposed — the others will see the new split", { icon: icon("users", 18) });
          done();
        },
      }));
    });

    reject.addEventListener("click", () => {
      buzz(8);
      if (!panel.hidden && panel.dataset.mode === "reject") { hidePanel(); return; }
      panel.dataset.mode = "reject";
      showPanel(rejectPanel({
        onCancel: hidePanel,
        onReject: async (reason) => {
          await rejectShared(spaceId, entryId, reason);
          toast("Rejected", { icon: icon("x", 18) });
          done();
        },
      }));
    });

    function showPanel(node) {
      panel.replaceChildren(node);
      panel.hidden = false;
      anim(panel, { y: -6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.22, ease: "power2.out" });
    }
    function hidePanel() {
      panel.hidden = true;
      panel.replaceChildren();
      delete panel.dataset.mode;
    }
    function done() {
      card.classList.add("is-done");
      const still = pendingForMe(spaceId).some((e) => e.id === entryId);
      if (still) paint(); else { card.remove(); onResolved && onResolved(); }
    }
  }

  /**
   * "Zubair sent you Rs 1,000". Two answers, and the only thing I have to
   * decide is which account it landed in — the amount is theirs to state, and
   * saying "Didn't receive" argues with it rather than editing it (§6).
   */
  function paintSettlement(space, entry) {
    card.classList.add("is-settlement");
    const from = entry.settlement?.from;
    const amount = Math.round(Number(entry.amount) || 0);

    const head = el("div", { class: "pend-head" });
    head.append(avatar(space, from));
    head.append(el("span", { class: "grow" },
      el("span", { class: "strong small", style: "display:block" },
        `${nameOf(space, from)} sent you`),
      el("span", { class: "xsmall muted" },
        `${agoLabel(entry.updatedAt || entry.createdAt)} · ${space.name}`)));
    head.append(el("span", { class: "pend-space-dot", style: `background:${colorHex(space.color)}` }));
    card.append(head);

    card.append(el("div", { class: "pend-share" },
      el("span", { class: "pend-share-label" }, "Sent to you"),
      el("span", { class: "pend-share-amt num" }, fmtMoney(amount))));

    const covers = entry.settlement?.covers || [];
    if (covers.length) {
      card.append(el("p", { class: "pend-sub xsmall muted" },
        `Covers ${covers.map((c) => `${sharedEntry(spaceId, c.id)?.title || "a share"} · ${fmtMoney(c.amount)}`).join(" · ")}`));
    } else {
      card.append(el("p", { class: "pend-sub xsmall muted" }, `Nothing in particular · ${shortDate(entry.date)}`));
    }

    const acc = accountRow(space, "Where did it land?");
    if (acc.field) card.append(acc.field);

    const actions = el("div", { class: "pend-actions" });
    const got = el("button", { type: "button", class: "btn btn-primary" }, "Got it");
    const nope = el("button", { type: "button", class: "btn btn-soft-danger" }, "Didn't receive");
    actions.append(got, nope);
    card.append(actions);

    got.addEventListener("click", async () => {
      buzz(12);
      got.disabled = nope.disabled = true;
      await acceptSettlement(spaceId, entryId, { accountId: acc.get() });
      toast(`${fmtMoney(amount)} added${acc.get() ? "" : " — pick an account next time"}`,
        { icon: icon("check-circle", 18) });
      settled();
    });
    nope.addEventListener("click", async () => {
      buzz(14);
      got.disabled = nope.disabled = true;
      await rejectSettlement(spaceId, entryId);
      toast(`${nameOf(space, from)} will be told it never arrived`, { icon: icon("x", 18) });
      settled();
    });

    function settled() {
      card.classList.add("is-done");
      card.remove();
      onResolved && onResolved();
    }
  }
}

/* ============================================================
   Inline panels
   ============================================================ */

/** Amount + split editor. Re-proposes: my yes stays, everyone else is asked. */
function editPanel(space, entry, { onSave, onCancel }) {
  const ids = Object.keys(entry.split?.shares || {});
  let mode = entry.split?.mode === "custom" ? "custom" : "equal";
  let total = Math.round(Number(entry.amount) || 0);
  const vals = new Map(ids.map((id) => [id, Math.round(Number(entry.split.shares[id]) || 0)]));

  const wrap = el("div", { class: "pend-edit" });
  const amt = el("input", {
    class: "input num", type: "text", inputmode: "numeric", value: String(total),
    "aria-label": "Total amount",
  });
  wrap.append(el("div", { class: "field" }, el("label", {}, "Total"),
    el("span", { class: "share-cell-in" }, el("span", { class: "cur-prefix" }, "Rs"), amt)));

  const segF = el("div", { class: "field" });
  segF.append(el("label", {}, "Split"), segmented(
    [{ label: "Equal", value: "equal" }, { label: "Custom", value: "custom" }],
    mode, (v) => { mode = v; recompute(); paintRows(); },
  ));
  wrap.append(segF);

  const grid = el("div", { class: "share-custom" });
  wrap.append(grid);
  const rem = el("p", { class: "share-rem" });
  wrap.append(rem);

  const save = el("button", { type: "button", class: "btn btn-primary" }, "Re-propose");
  wrap.append(el("div", { class: "form-actions" },
    el("button", { type: "button", class: "btn btn-ghost", onclick: onCancel }, "Cancel"), save));

  amt.addEventListener("input", () => {
    const clean = amt.value.replace(/[^0-9]/g, "");
    if (clean !== amt.value) amt.value = clean;
    total = Number(clean) || 0;
    recompute();
    paintRows();
  });

  function recompute() {
    if (mode !== "equal") return;
    const eq = splitEqually(total, ids, entry.paidBy);
    for (const id of ids) vals.set(id, eq[id] || 0);
  }

  function paintRows() {
    grid.replaceChildren();
    for (const id of ids) {
      const input = el("input", {
        class: "input input-sm num", type: "text", inputmode: "numeric",
        value: String(vals.get(id) || 0), disabled: mode === "equal" || undefined,
        "aria-label": `${nameOf(space, id)}'s share`,
      });
      input.addEventListener("input", () => {
        const clean = input.value.replace(/[^0-9]/g, "");
        if (clean !== input.value) input.value = clean;
        vals.set(id, Number(clean) || 0);
        paintRem();
      });
      grid.append(el("div", { class: "share-cell" },
        el("span", { class: "share-cell-name truncate" }, nameOf(space, id)),
        el("span", { class: "share-cell-in" }, el("span", { class: "cur-prefix" }, "Rs"), input)));
    }
    paintRem();
  }

  function paintRem() {
    const sum = ids.reduce((a, id) => a + (Number(vals.get(id)) || 0), 0);
    const left = total - sum;
    rem.className = `share-rem ${left === 0 ? "is-ok" : "is-off"}`;
    rem.textContent = left === 0 ? "Adds up exactly"
      : left > 0 ? `${fmtMoney(left)} left to assign` : `${fmtMoney(-left)} too much`;
    save.disabled = left !== 0 || total <= 0;
  }

  save.addEventListener("click", () => {
    buzz(12);
    save.disabled = true;
    onSave({ amount: total, shares: Object.fromEntries(ids.map((id) => [id, vals.get(id) || 0])), mode });
  });

  recompute();
  paintRows();
  return wrap;
}

/** Reason chips, then the confirm. Soft danger — a reject is reversible. */
function rejectPanel({ onReject, onCancel }) {
  let reason = null;
  const wrap = el("div", { class: "pend-reject" });
  wrap.append(el("p", { class: "xsmall muted", style: "margin:0 0 8px" }, "Why not?"));
  const row = el("div", { class: "filter-row", style: "margin:0" });
  for (const r of REJECT_REASONS) {
    const b = el("button", {
      type: "button", class: "filter-chip",
      onclick: () => {
        reason = reason === r ? null : r;
        buzz(6);
        [...row.children].forEach((c) => c.classList.remove("is-active"));
        if (reason) b.classList.add("is-active");
      },
    }, r);
    row.append(b);
  }
  wrap.append(row);
  const go = el("button", { type: "button", class: "btn btn-soft-danger" }, "Reject my share");
  wrap.append(el("div", { class: "form-actions" },
    el("button", { type: "button", class: "btn btn-ghost", onclick: onCancel }, "Cancel"), go));
  go.addEventListener("click", () => { buzz(14); go.disabled = true; onReject(reason); });
  return wrap;
}

/* ============================================================
   Waiting on others
   ============================================================ */

/**
 * One of my own proposals: what it was, who has answered, and — when somebody
 * said no — the rupees their rejection left with nobody's name on them (§9.10).
 */
export function waitingCard(spaceId, entryId, { onChanged = null } = {}) {
  const card = el("div", { class: "pend-card is-waiting" });
  paint();
  return card;

  function paint() {
    const space = getSpace(spaceId);
    const entry = sharedEntry(spaceId, entryId);
    card.innerHTML = "";
    if (!space || !entry) { card.remove(); return; }

    const isSettle = entry.kind === "settlement";
    card.append(el("div", { class: "pend-title" },
      el("span", { class: "pend-cat", html: isSettle ? icon("swap", 17) : catIcon(entry.category, 17) }),
      el("span", { class: "truncate" }, isSettle
        ? `Sent to ${nameOf(space, entry.settlement?.to)}`
        : (entry.title || "Untitled")),
      el("span", { class: "pend-total num" }, fmtMoney(entry.amount))));
    card.append(el("p", { class: "pend-sub xsmall muted" }, isSettle
      ? `Waiting for ${nameOf(space, entry.settlement?.to)} to confirm · ${shortDate(entry.date)}`
      : `${splitLine(space, entry)} · ${shortDate(entry.date)}`));

    const who = el("div", { class: "pend-who" });
    for (const [id, p] of Object.entries(entry.participants || {})) {
      const m = memberOf(space, id);
      who.append(el("span", { class: `pend-who-one is-${esc(p.status)}` },
        el("i", { class: "sv-dot is-" + esc(p.status), style: `--dot:${colorHex(m?.color, MEMBER_COLORS)}` }),
        el("span", {}, `${nameOf(space, id)} · ${p.status}`)));
    }
    card.append(who);

    const left = unassignedOf(entry);
    if (left > 0) {
      const box = el("div", { class: "pend-unassigned" });
      box.append(el("p", { class: "strong small" }, `${fmtMoney(left)} unassigned`));
      box.append(el("p", { class: "xsmall muted" },
        "Somebody rejected their share. It still has to come from somewhere."));
      const acts = el("div", { class: "form-actions" });
      const mk = (label, how, cls) => el("button", {
        type: "button", class: `btn ${cls}`,
        onclick: async (e) => {
          buzz(12);
          [...acts.children].forEach((c) => (c.disabled = true));
          await resolveUnassigned(spaceId, entryId, how);
          toast(how === "split" ? "Split among the rest" : "You're covering it",
            { icon: icon("check-circle", 18) });
          onChanged && onChanged();
          paint();
          void e;
        },
      }, label);
      acts.append(mk("Split among the rest", "split", "btn-ghost"),
        mk("I'll cover it", "cover", "btn-primary"));
      box.append(acts);
      card.append(box);
    }

    // Withdrawing my own proposal (plan 9.8 / 9.13). Two taps, because it is a
    // delete for everyone: their copies go too, and anyone who had already
    // accepted is told "Zubair removed this" on their next pull.
    if (!isSettle && entry.proposedBy === space.myMemberId) {
      const btn = el("button", { type: "button", class: "btn btn-ghost btn-block pend-withdraw" },
        "Withdraw this");
      let armed = false;
      let timer = null;
      btn.addEventListener("click", async () => {
        if (!armed) {
          buzz(10);
          armed = true;
          btn.textContent = "Tap to confirm";
          btn.classList.add("is-armed");
          timer = setTimeout(() => {
            armed = false;
            btn.textContent = "Withdraw this";
            btn.classList.remove("is-armed");
          }, 3000);
          return;
        }
        clearTimeout(timer);
        buzz(16);
        btn.disabled = true;
        await removeShared(spaceId, entryId);
        toast("Withdrawn", { icon: icon("trash", 18) });
        onChanged && onChanged();
      });
      card.append(btn);
    }
  }
}

/* ============================================================
   The pending sheet
   ============================================================ */

/** Everything waiting on me, across every space. `spaceId` narrows it to one. */
export function pendingSheet(spaceId = null) {
  openSheet("Shared requests", (body) => {
    const list = el("div", { class: "pend-list" });
    body.append(list);
    const empty = el("div", {
      class: "empty", style: "border:none;background:none;padding:26px",
      html: `<div class="empty-ico">${icon("check-circle", 26)}</div><p>Nothing pending here.</p>`,
    });

    const items = allPending().filter(({ space }) => !spaceId || space.id === spaceId);
    if (!items.length) { body.append(empty); return; }

    for (const { space, entry } of items) {
      list.append(pendingCard(space.id, entry.id, {
        onResolved: () => {
          if (list.children.length) return;
          // The last one answered: say so rather than leaving a blank sheet.
          list.replaceWith(empty);
          setTimeout(() => closeSheet(), 900);
        },
      }));
    }
    anim(list.children, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, stagger: 0.06, ease: "power2.out" });
  });
}
