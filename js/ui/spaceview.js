// The space screen: a view with no dock item, reached with go("space", { id }).
//
// Everything on it is read from the decrypted blob in js/spaces.js and nothing
// on it re-renders the page: a background pull calls repaint() through
// onSpacesChange, which redraws this view and nothing else.
//
// Milestone 2 ships the whole rendering path with no shared entries to show —
// proposals arrive in M3, which only has to fill `entries` and wire the accept
// card into the two placeholder sections.

import { $, el, esc, anim, buzz } from "../util/dom.js";
import { icon, catIcon } from "./icons.js";
import {
  fmtMoney, fmtCompact, monthLabel, thisMonth, shiftMonth, dayLabel, daysUntil,
} from "../util/format.js";
import {
  getSpace, blobOf, membersOf, netFor, pendingForMe, waitingOnOthers, conflictsIn,
  spaceStatus, colorHex, initialsOf, MEMBER_COLORS, writeOffMember,
  archivedEntries, staleIn, contactOf, forgetSpace, compactionFor, STALE_DAYS,
} from "../spaces.js";
import { transferSheet } from "./modals.js";
import { toast } from "./toast.js";
import {
  memberStack, netLine, STATUS_TEXT, spaceSettingsSheet, inviteSheet, memberLinkSheet,
} from "./spaces.js";
import { pendingCard, waitingCard } from "./pendingcard.js";

/** Which space and which month the view is looking at. */
let currentId = null;
let currentMonth = thisMonth();

export function setSpaceTarget(id) {
  if (id && id !== currentId) currentMonth = thisMonth();
  currentId = id || currentId;
}

export const spaceTarget = () => currentId;

export function renderSpace(view) {
  const space = getSpace(currentId);
  if (!space) {
    view.innerHTML = `<div class="empty"><div class="empty-ico">${icon("users", 26)}</div>
      <h3>This space isn't on this phone</h3>
      <p>It may have been left or removed. Open Settings to join it again.</p></div>`;
    return;
  }

  paintCanopy(space);

  const blob = blobOf(space.id);
  const st = spaceStatus(space.id);
  view.innerHTML = "";

  // Closed on the relay while I had it open (plan 9.30). There is nothing left
  // to pull, push or settle here - the only honest thing to offer is letting
  // go of it, and my own rows keep their money either way.
  if (st === "gone") {
    const empty = el("div", { class: "empty", id: "sv-closed" });
    empty.innerHTML = `<div class="empty-ico">${icon("users", 26)}</div>
      <h3>This space was closed</h3>
      <p>Everyone left ${esc(space.name)}, so there is nothing to sync any more.
      Anything you already accepted stays in your own ledger.</p>`;
    empty.append(el("button", {
      class: "btn btn-soft-danger", style: "margin-top:14px",
      html: `${icon("trash", 16)} Remove from this phone`,
      onclick: async () => {
        await forgetSpace(space.id);
        toast(`Removed ${space.name}`, { icon: icon("check-circle", 18) });
        import("../app.js").then((m) => m.go("home"));
      },
    }));
    view.append(empty);
    anim(empty, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" });
    return;
  }

  if (st !== "ok") {
    view.append(el("div", {
      class: "warn-card", style: "margin-bottom:16px",
      html: `${icon("alert", 15)} ${esc(STATUS_TEXT[st] || "")}`,
    }));
  }

  // The blob has outgrown what the relay will take (plan 9.4). Compaction is
  // the fix and it lives in the space settings sheet, so this points at it.
  const size = compactionFor(space.id);
  if (st === "too-large" || size.urgent) {
    view.append(el("div", { class: "warn-card", style: "margin-bottom:16px" },
      el("span", { html: `${icon("alert", 15)} This space is too big to sync. Compact its older history to get it moving again.` }),
      el("button", {
        class: "btn btn-sm", style: "margin-top:10px",
        onclick: () => spaceSettingsSheet(space.id),
      }, "Compact now")));
  }

  view.append(monthNav(view));

  // 1 — Pending for you: the full accept card, the same component the pending
  // sheet uses. Answering one repaints this view and nothing else.
  const pending = pendingForMe(space.id);
  view.append(pending.length
    ? loose("Pending for you", "sv-pending", pending.length,
      pending.map((e) => pendingCard(space.id, e.id, { onResolved: () => renderSpace(view) })))
    : section("Pending for you", "sv-pending", 0, [quiet("Nothing is waiting on you here.")]));

  // 2 — Waiting on others: my proposals, with a status dot per member and the
  // unassigned-remainder decision when somebody has said no (§9.10).
  const waiting = waitingOnOthers(space.id);
  view.append(waiting.length
    ? loose("Waiting on others", "sv-waiting", waiting.length,
      waiting.map((e) => waitingCard(space.id, e.id, { onChanged: () => renderSpace(view) })))
    : section("Waiting on others", "sv-waiting", 0, [quiet("Nothing of yours is waiting on anyone.")]));

  // 3 — Balances
  view.append(balancesBlock(space, view));

  // 4 — Records, grouped by day with the History divider
  view.append(recordsBlock(space, blob));

  // 5 — Conflicts (rare)
  const clashes = conflictsIn(space.id);
  if (clashes.length) {
    view.append(section("Edited at the same time", "sv-conflicts", clashes.length,
      clashes.map((e) => conflictRow(e, space))));
  }

  anim(view.children, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, stagger: 0.05, ease: "power2.out" });
}

/* ============================================================
   Canopy
   ============================================================ */

function paintCanopy(space) {
  const slot = $("#canopy-slot");
  if (!slot) return;
  const { net } = netFor(space.id);
  const line = netLine(net);
  slot.innerHTML = "";

  const head = el("div", { class: "sv-head" });
  head.append(el("button", {
    class: "icon-btn sv-back", "aria-label": "Back",
    html: icon("chevron-left", 20),
    onclick: () => { buzz(8); import("../app.js").then((m) => m.goBackFromSpace()); },
  }));
  head.append(el("span", { class: "sv-title truncate" }, space.name));
  head.append(memberStack(membersOf(space.id), {
    size: 28,
    selfId: space.myMemberId,
    onMember: (m) => memberLinkSheet(space.id, m.memberId, {
      onChanged: () => renderSpace($("#view")),
    }),
  }));
  head.append(el("button", {
    class: "icon-btn", "aria-label": "Space settings",
    // not the gear: at 18px its spokes read as the theme toggle's sun, which
    // sits two buttons away in the same header
    html: icon("more", 18),
    onclick: () => spaceSettingsSheet(space.id, { onGone: () => import("../app.js").then((m) => m.go("settings")) }),
  }));
  slot.append(head);

  slot.append(el("section", { class: "hero sv-hero" },
    el("div", { class: "hero-label" }, net > 0 ? "Owed to you" : net < 0 ? "You owe" : "All settled"),
    el("div", { class: `hero-amount num sv-net is-${line.tone}` }, fmtMoney(Math.abs(net))),
  ));
}

/* ============================================================
   Blocks
   ============================================================ */

function monthNav(view) {
  const isNow = currentMonth === thisMonth();
  const nav = el("div", { class: "month-nav" });
  nav.append(el("button", {
    class: "icon-btn", "aria-label": "Previous month", html: icon("chevron-left", 18),
    onclick: () => { currentMonth = shiftMonth(currentMonth, -1); renderSpace(view); },
  }));
  nav.append(el("div", { class: "month-label" }, monthLabel(currentMonth)));
  nav.append(el("button", {
    class: "icon-btn", "aria-label": "Next month", html: icon("chevron-right", 18),
    disabled: isNow || undefined,
    style: isNow ? "opacity:.35" : undefined,
    onclick: () => {
      if (currentMonth >= thisMonth()) return;
      currentMonth = shiftMonth(currentMonth, 1);
      renderSpace(view);
    },
  }));
  return nav;
}

function section(title, id, count, children) {
  const wrap = el("div", { class: "sv-section", id });
  const head = el("div", { class: "spread", style: "margin:var(--s-5) 0 var(--s-2)" });
  head.append(el("h2", {}, title));
  if (count) head.append(el("span", { class: "count" }, String(count)));
  wrap.append(head, el("div", { class: "card" }, ...children));
  return wrap;
}

/** Same heading, but the children ARE the cards — no surrounding .card box. */
function loose(title, id, count, children) {
  const wrap = el("div", { class: "sv-section is-loose", id });
  const head = el("div", { class: "spread", style: "margin:var(--s-5) 0 var(--s-2)" });
  head.append(el("h2", {}, title));
  if (count) head.append(el("span", { class: "count" }, String(count)));
  wrap.append(head, ...children);
  return wrap;
}

const quiet = (text) => el("p", { class: "sv-quiet" }, text);

function balancesBlock(space, view) {
  const { perMember } = netFor(space.id);
  const others = membersOf(space.id).filter((m) => m.memberId !== space.myMemberId);
  const stale = new Set(staleIn(space.id).map((m) => m.memberId));
  const rows = others.map((m) => {
    const v = Math.round(perMember[m.memberId] || 0);
    const row = el("div", { class: "sv-bal" });
    // The avatar is the "same person as..." affordance here (plan section 8),
    // so the row's Settle button keeps the whole of the primary tap target.
    row.append(el("button", {
      type: "button", class: "sp-av is-tappable",
      style: `background:${colorHex(m.color, MEMBER_COLORS)}`,
      "aria-label": `${m.name}: link to the same person in another space`,
      title: `${m.name} \u2014 same person as\u2026`,
      onclick: () => {
        buzz(6);
        memberLinkSheet(space.id, m.memberId, { onChanged: () => view && renderSpace(view) });
      },
    }, initialsOf(m.name)));
    const link = contactOf(space.id, m.memberId);
    const money = m.leftAt ? (v ? `Left \u00b7 owed ${fmtMoney(Math.abs(v))}` : "Left")
      : v > 0 ? `owes you ${fmtMoney(v)}`
        : v < 0 ? `you owe ${fmtMoney(-v)}`
          : "settled up";
    const tail = !m.leftAt && stale.has(m.memberId)
      ? ` \u00b7 inactive ${STALE_DAYS}d`
      : link ? " \u00b7 linked" : "";
    row.append(el("span", { class: "grow" },
      el("span", { class: "strong small", style: "display:block" }, m.name),
      el("span", { class: "xsmall muted" }, money + tail)));
    // Someone who left is never going to press Accept, so there is nothing to
    // settle with them — only the decision to stop counting on it (§9.18).
    if (m.leftAt && v > 0) {
      row.append(writeOffButton(space, m, v, view));
    } else if (v) {
      row.append(el("button", {
        class: "chip-btn chip-edit",
        title: v > 0 ? `Record what ${m.name} paid you` : `Send ${m.name} what you owe`,
        onclick: () => {
          buzz(8);
          // Prefilled with the person, the space, every cover ticked, and the
          // account this space was last paid from (plan §6).
          transferSheet({
            spaceId: space.id, memberId: m.memberId, coverAll: true,
            fromAccountId: space.lastAccountId,
          });
        },
      }, "Settle"));
    }
    return row;
  });

  if (!rows.length) {
    rows.push(quiet("You're the only one here. Share the invite code to add someone."));
    rows.push(el("button", {
      class: "btn btn-ghost btn-block", style: "margin:12px 0 4px",
      html: `${icon("qr-code", 16)} Show invite code`,
      onclick: () => inviteSheet(space),
    }));
  }
  return section("Balances", "sv-balances", 0, rows);
}

/** Tap to arm, tap to confirm — the same shape every other write-off-sized
 * decision in the app has, because this one cannot be undone from here. */
function writeOffButton(space, member, owed, view) {
  const btn = el("button", { class: "chip-btn chip-writeoff" }, "Write off");
  let armed = false, timer = null;
  btn.addEventListener("click", async () => {
    if (!armed) {
      buzz(10);
      armed = true;
      btn.textContent = "Tap to confirm";
      timer = setTimeout(() => { armed = false; btn.textContent = "Write off"; }, 3000);
      return;
    }
    buzz(16);
    clearTimeout(timer);
    btn.disabled = true;
    await writeOffMember(space.id, member.memberId);
    toast(`${fmtMoney(owed)} written off · ${member.name}`, { icon: icon("scale", 17) });
    if (view) renderSpace(view);
  });
  return btn;
}

/* ============================================================
   Records
   ============================================================ */

/**
 * Shared entries for the month on screen, newest first - from the blob AND
 * from this phone's own archive, so a month that has been compacted away on
 * the relay still reads in full here (plan section 8). An id in both wins from
 * the blob, which is the live copy.
 */
function recordsFor(blob, ym, spaceId) {
  const live = (blob?.entries || []).filter((e) => String(e.date || "").slice(0, 7) === ym);
  const have = new Set(live.map((e) => e.id));
  const old = archivedEntries(spaceId)
    .filter((e) => String(e.date || "").slice(0, 7) === ym && !have.has(e.id))
    .map((e) => ({ ...e, archived: true }));
  return [...live, ...old].sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1));
}

function recordsBlock(space, blob) {
  const list = recordsFor(blob, currentMonth, space.id);
  const wrap = el("div", { class: "sv-section", id: "sv-records" });
  const head = el("div", { class: "spread", style: "margin:var(--s-5) 0 var(--s-2)" });
  head.append(el("h2", {}, "Records"));
  if (list.length) head.append(el("span", { class: "count" }, String(list.length)));
  wrap.append(head);

  const card = el("div", { class: "card" });
  if (!list.length) {
    card.append(el("div", { class: "empty", style: "border:none;background:none;padding:26px" },
      el("div", { class: "empty-ico", html: icon("inbox", 26) }),
      el("p", { class: "sv-hand" }, "Nothing shared yet. Add an expense and pick " + space.name + ".")));
    wrap.append(card);
    return wrap;
  }

  // group into days, each under the History divider
  const groups = [];
  for (const e of list) {
    const day = String(e.date).slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(e);
    else groups.push({ day, rows: [e] });
  }
  groups.forEach((g, i) => {
    card.append(dayDivider(g.day, g.rows, i === 0, space));
    g.rows.forEach((e, j) => {
      const row = entryRow(e, space);
      if (!row) return;
      if (j === 0) row.classList.add("is-day-first");
      if (e.archived) row.classList.add("is-archived");
      card.append(row);
    });
  });
  if (list.some((e) => e.archived)) {
    card.append(el("p", { class: "sv-archive-note" },
      "Older entries are kept on this phone only \u2014 the space itself carries the totals."));
  }
  wrap.append(card);
  return wrap;
}

/** My side of one day's entries, as the History day chip. */
function dayTotal(rows, space) {
  let mine = 0;
  for (const e of rows) {
    switch (e.kind) {
      case "expense": mine += Number(e.split?.shares?.[space.myMemberId]) || 0; break;
      case "income": mine -= Number(e.split?.shares?.[space.myMemberId]) || 0; break;
      case "settlement": break; // moves money between two people, not spending
      default: break;           // a kind this build has no rule for
    }
  }
  if (!mine) return `<span class="sum out num">−</span>`;
  return mine > 0
    ? `<span class="sum out num">−${fmtCompact(mine)}</span>`
    : `<span class="sum in num">+${fmtCompact(-mine)}</span>`;
}

function dayDivider(day, rows, first, space) {
  const [wd, num, mon] = dayLabel(day).split(" ");
  const d = daysUntil(day);
  const rel = d === 0 ? "Today" : d === -1 ? "Yesterday" : d === 1 ? "Tomorrow" : "";
  const longDay = new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long" });
  return el("div", {
    class: `hist-day ${first ? "is-first" : ""} ${d === 0 ? "is-today" : ""}`,
    html: `
      <span class="hist-day-date"><b class="num">${num}</b><small>${wd}</small></span>
      <span class="hist-day-name">${rel || longDay}<span> · ${num} ${mon}</span></span>
      <span class="hist-day-sum">${dayTotal(rows, space)}</span>`,
  });
}

const memberName = (space, id) =>
  membersOf(space.id).find((m) => m.memberId === id)?.name || "Someone";

/**
 * One SharedEntry row. Dispatch is explicit per kind so an entry written by a
 * newer build draws nothing rather than the wrong thing.
 */
export function entryRow(e, space) {
  switch (e.kind) {
    case "expense":
    case "income":
      return sharedMoneyRow(e, space, e.kind === "income");
    case "settlement":
      return settlementRow(e, space);
    default:
      return null;
  }
}

function statusDots(e, space) {
  const entries = Object.entries(e.participants || {});
  if (!entries.length) return "";
  return `<span class="sv-dots">${entries.map(([id, p]) => {
    const m = membersOf(space.id).find((x) => x.memberId === id);
    return `<i class="sv-dot is-${esc(p.status)}" style="--dot:${colorHex(m?.color, MEMBER_COLORS)}" title="${esc((m?.name || "?") + " · " + p.status)}"></i>`;
  }).join("")}</span>`;
}

function sharedMoneyRow(e, space, inn) {
  const share = Math.round(Number(e.split?.shares?.[space.myMemberId]) || 0);
  const ways = Object.keys(e.split?.shares || {}).length;
  const row = el("div", { class: "hist-row sv-row" });
  row.innerHTML = `
    <span class="hist-ico" style="background:${inn ? "var(--c-pos-soft)" : "var(--c-violet-soft)"};color:${inn ? "var(--c-pos)" : "var(--c-violet)"}">
      ${inn ? icon("banknote", 18) : catIcon(e.category, 18)}
    </span>
    <span class="grow">
      <span class="strong small truncate" style="display:block">${esc(e.title || "Untitled")}</span>
      <span class="xsmall muted">paid by ${esc(memberName(space, e.paidBy))}${ways ? ` · split ${ways} way${ways === 1 ? "" : "s"}` : ""}</span>
      ${statusDots(e, space)}
    </span>
    <span class="hist-amt num ${inn ? "in" : ""}">${inn ? "+" : "−"}${fmtCompact(Math.abs(share))}</span>`;
  return row;
}

function settlementRow(e, space) {
  const { from, to } = e.settlement || {};
  const out = from === space.myMemberId;
  const other = memberName(space, out ? to : from);
  const row = el("div", { class: "hist-row sv-row" });
  row.innerHTML = `
    <span class="hist-ico" style="background:var(--c-aqua-soft);color:var(--c-aqua)">${icon("swap", 18)}</span>
    <span class="grow">
      <span class="strong small truncate" style="display:block">${out ? "Sent to" : "From"} ${esc(other)}</span>
      <span class="xsmall muted">settlement</span>
      ${statusDots(e, space)}
    </span>
    <span class="hist-amt num ${out ? "" : "in"}">${out ? "−" : "+"}${fmtCompact(Number(e.amount) || 0)}</span>`;
  return row;
}

function conflictRow(e, space) {
  const row = el("div", { class: "sv-conflict" });
  row.append(el("span", { class: "strong small" }, e.title || "Untitled"),
    el("span", { class: "xsmall muted" },
      `Two people edited this at the same time · ${e.conflicts.length} other version${e.conflicts.length === 1 ? "" : "s"}`));
  // Keep this / Keep that lands with the entry editor in M3.
  return row;
}
