// Every shared-space sheet: the switcher, create, invite, join and the
// per-space settings panel.
//
// Sheets cannot nest (see js/ui/catedit.js). Two rules follow from that and are
// kept throughout this file:
//   • a sheet that leads somewhere else CLOSES first and opens the next one on
//     the next tick — a hand-off, never a stack;
//   • a step inside one flow (create -> invite, paste -> confirm, leave ->
//     confirm) is an INLINE PANEL: the same sheet body is repainted.

import { $, el, esc, anim, buzz } from "../util/dom.js";
import { getMeta, setMeta } from "../db.js";
import { icon } from "./icons.js";
import { toast } from "./toast.js";
import { openSheet, closeSheet, sheetOpen } from "./modals.js";
import { fmtMoney } from "../util/format.js";
import {
  SPACE_COLORS, MEMBER_COLORS, colorHex, initialsOf,
  spaces, getSpace, blobOf, membersOf, netFor, pendingForMe, spaceStatus,
  createSpace, previewInvite, joinSpace, adoptInvite, renameSpace, renameMe, leaveSpace,
  rotateSpace, forgetSpace, inviteCodeFor, profile, saveProfile, suggestName,
  nameTaken, setNotifDetails, relayConfigured, pullSpace, onSpacesChange,
  spacePushState, enableSpacePush, disableSpacePush,
  contactOf, linkCandidates, linkMembers, unlinkMember, acrossSpaces,
  compactionFor, compactionPreview, compactSpace, staleIn, pendingRotation,
  memberNameIn, STALE_DAYS,
} from "../spaces.js";
import { inviteLink } from "../spaces/crypto.js";
import { qrSvg } from "../vendor/qrcode.js";

/* ============================================================
   Shared bits
   ============================================================ */

/** Hand off from one sheet to the next without ever nesting them. */
function handOff(open) {
  closeSheet();
  setTimeout(open, 260);
}

/** A row of colour dots. `onPick` gets the colour name. */
function colorPicker(map, active, onPick) {
  const row = el("div", { class: "sp-colors", role: "radiogroup", "aria-label": "Colour" });
  const dots = Object.entries(map).map(([name, hex]) => {
    const b = el("button", {
      type: "button", class: `sp-color ${name === active ? "is-active" : ""}`,
      role: "radio", "aria-checked": String(name === active), "aria-label": name,
      style: `--dot:${hex}`,
      onclick: () => {
        active = name;
        dots.forEach((d) => {
          const on = d.dataset.name === name;
          d.classList.toggle("is-active", on);
          d.setAttribute("aria-checked", String(on));
        });
        buzz(6);
        onPick(name);
      },
    });
    b.dataset.name = name;
    row.append(b);
    return b;
  });
  return row;
}

/** A label with a switch on the right — the same control the sheets use. */
function switchRow(labelText, checked, onFlip, hint = "") {
  let on = !!checked;
  const sw = el("button", {
    type: "button", class: "switch", role: "switch",
    "aria-checked": String(on), "aria-label": labelText,
  });
  sw.addEventListener("click", () => {
    on = !on;
    sw.setAttribute("aria-checked", String(on));
    buzz(6);
    onFlip(on);
  });
  const row = el("div", { class: "toggle-row" }, el("span", { class: "strong small" }, labelText), sw);
  if (!hint) return row;
  return el("div", {}, row, el("p", { class: "xsmall muted", style: "margin:-4px 0 4px" }, hint));
}

/** Overlapping member initials, in each member's own colour. */
export function memberStack(members, { max = 4, size = 26, onMember = null, selfId = null } = {}) {
  const wrap = el("span", { class: "sp-stack", style: `--av:${size}px` });
  const live = members.filter((m) => !m.leftAt);
  for (const m of live.slice(0, max)) {
    // With a handler each head is a real button ("Same person as…", plan §8);
    // without one it stays a plain span, so nothing inside a card becomes an
    // accidental tap target. MY OWN head is never a button: I cannot be two
    // different people in two spaces, so there is nothing to link me to.
    wrap.append(onMember && m.memberId !== selfId
      ? el("button", {
        type: "button", class: "sp-av is-tappable",
        style: `background:${colorHex(m.color, MEMBER_COLORS)}`,
        title: `${m.name} — same person as…`,
        "aria-label": `${m.name}: link to the same person in another space`,
        onclick: (e) => { e.stopPropagation(); buzz(6); onMember(m); },
      }, initialsOf(m.name))
      : el("span", {
        class: "sp-av", style: `background:${colorHex(m.color, MEMBER_COLORS)}`,
        title: m.name,
      }, initialsOf(m.name)));
  }
  if (live.length > max) wrap.append(el("span", { class: "sp-av is-more" }, `+${live.length - max}`));
  return wrap;
}

/** "You're owed Rs 1,350" / "You owe Rs 400" / "Settled". */
export function netLine(net) {
  if (!net) return { text: "Settled", tone: "flat" };
  if (net > 0) return { text: `You're owed ${fmtMoney(net)}`, tone: "pos" };
  return { text: `You owe ${fmtMoney(-net)}`, tone: "neg" };
}

/** The one sentence each trouble state gets, wherever there is room for it. */
export const STATUS_TEXT = {
  expired: "This invite has expired — ask for a new one",
  gone: "This space was closed",
  offline: "Can't reach the relay — showing the last copy",
  "too-large": "This space is too big to sync — compact it below",
};

/** The same states in a Settings row's value column, which has two words. */
const STATUS_SHORT = {
  expired: "Invite expired", gone: "Closed", offline: "Offline", "too-large": "Too big",
};

/** Retitle the sheet we are inside — an inline panel is still a new step. */
function retitle(node, text) {
  const h = node.closest(".sheet")?.querySelector("h2");
  if (h) h.textContent = text;
}

/* ============================================================
   Switcher
   ============================================================ */

export function spacesSwitcherSheet() {
  openSheet("Shared spaces", (body) => {
    const panel = el("div", {});
    body.append(panel);
    paintGrid();

    function paintGrid() {
      panel.innerHTML = "";
      retitle(panel, "Shared spaces");
      const grid = el("div", { class: "sp-grid" });
      for (const s of spaces()) grid.append(spaceCard(s, onMember));
      panel.append(grid);

      // "Across spaces": one linked human, their balance in each space, side by
      // side. Deliberately NOT netted - the rupees live in two spaces and only
      // the two of them can decide to move one against the other (plan section 8).
      const across = acrossSpaces();
      if (across.length) panel.append(acrossBlock(across));

      panel.append(el("div", { class: "sp-grid sp-grid-actions" },
        el("button", {
          class: "sp-card sp-card-ghost", onclick: () => handOff(() => createSpaceSheet()),
        }, el("span", { class: "sp-ghost-ico", html: icon("plus", 20) }), el("span", {}, "New space")),
        el("button", {
          class: "sp-card sp-card-ghost", onclick: () => handOff(() => joinSpaceSheet()),
        }, el("span", { class: "sp-ghost-ico", html: icon("qr-code", 20) }), el("span", {}, "Join with code")),
      ));
      // 9.32: anim() collapses to a gsap.set with no stagger under reduced
      // motion, so the cards simply appear.
      anim(grid.children, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, stagger: 0.05, ease: "power2.out" });
    }

    function onMember(spaceId, member) {
      panel.innerHTML = "";
      panel.append(memberLinkPanel(spaceId, member.memberId, { back: paintGrid, retitleIn: panel }));
    }
  });
}

/** The cross-space line under the grid. */
function acrossBlock(across) {
  const wrap = el("div", { class: "sp-across" });
  wrap.append(el("h3", { class: "sp-subhead", style: "margin-top:18px" }, "Across spaces"));
  const card = el("div", { class: "card" });
  for (const p of across) {
    const row = el("div", { class: "sp-across-row" });
    row.append(el("span", { class: "grow" },
      el("span", { class: "strong small", style: "display:block" }, p.name),
      el("span", { class: "xsmall muted" },
        p.spaces.map((x) => `${x.spaceName} ${x.net > 0 ? "+" : "\u2212"}${fmtMoney(Math.abs(x.net))}`).join(" \u00b7 "))));
    const line = netLine(p.total);
    row.append(el("span", { class: `sp-net is-${line.tone}` }, line.text));
    card.append(row);
  }
  wrap.append(card);
  wrap.append(el("p", { class: "xsmall muted", style: "margin:6px 4px 0" },
    "Shown side by side, never netted \u2014 each space settles on its own."));
  return wrap;
}

function spaceCard(s, onMember = null) {
  const members = membersOf(s.id);
  const { net } = netFor(s.id);
  const line = netLine(net);
  const pending = pendingForMe(s.id).length;
  const st = spaceStatus(s.id);

  // A div with role=button, not a <button>: the member heads inside it are
  // buttons of their own ("Same person as..."), and a button inside a button is
  // not a thing the DOM allows.
  const open = () => {
    closeSheet();
    setTimeout(() => import("../app.js").then((m) => m.go("space", { id: s.id })), 220);
  };
  const card = el("div", {
    class: "sp-card", role: "button", tabindex: "0",
    "aria-label": `${s.name} \u2014 open`,
    style: `--sp:${colorHex(s.color)}`,
    onclick: open,
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } },
  });
  card.append(el("span", { class: "sp-strip" }));
  card.append(el("span", { class: "sp-card-name truncate" }, s.name));
  card.append(memberStack(members, {
    selfId: s.myMemberId,
    onMember: onMember ? (m) => onMember(s.id, m) : null,
  }));
  if (pending) card.append(el("span", { class: "sp-pill" }, `${pending} for you`));
  card.append(el("span", { class: `sp-net is-${line.tone}` }, line.text));
  if (st !== "ok") card.append(el("span", { class: "sp-warn" }, STATUS_TEXT[st] || ""));
  return card;
}

/* ============================================================
   "Same person as..." - contact linking (plan section 8)
   ============================================================ */

/**
 * The inline panel both the switcher and the space settings sheet paint when a
 * member is tapped. It is a list of everyone in my OTHER spaces, and picking
 * one says "these two are the same human". The link lives only in my ledger.
 */
export function memberLinkPanel(spaceId, memberId, { back = null, retitleIn = null } = {}) {
  const wrap = el("div", { class: "sp-link-panel" });
  paint();
  return wrap;

  function paint() {
    wrap.innerHTML = "";
    const name = memberNameIn(spaceId, memberId);
    if (retitleIn) retitle(retitleIn, "Same person as\u2026");
    wrap.append(el("h3", { class: "sp-panel-title" }, `Is ${name} someone you already know?`));
    wrap.append(el("p", { class: "muted", style: "margin-bottom:14px" },
      "Linking two members tells Batwa they are one person, so they appear once when you send money. Nothing is shared with anyone \u2014 the link stays on this phone, inside your ledger."));

    const contact = contactOf(spaceId, memberId);
    const list = linkCandidates(spaceId, memberId);
    const card = el("div", { class: "card sp-members" });

    if (!spaces().some((x) => x.id !== spaceId)) {
      card.append(el("p", { class: "xsmall muted", style: "padding:4px" },
        "You're only in one space, so there is nobody to link them to yet."));
    } else if (!list.length) {
      card.append(el("p", { class: "xsmall muted", style: "padding:4px" },
        "Everyone in your other spaces is already linked to somebody else."));
    }

    for (const c of list) {
      const row = el("button", { class: "sp-member sp-member-btn", type: "button" });
      row.append(el("span", { class: "sp-av", style: `background:${colorHex(c.color, MEMBER_COLORS)}` }, initialsOf(c.name)));
      row.append(el("span", { class: "grow", style: "text-align:left" },
        el("span", { class: "strong small", style: "display:block" }, c.name),
        el("span", { class: "xsmall muted" }, c.spaceName)));
      row.append(el("span", { class: c.linked ? "badge badge-once is-on" : "chev" }, c.linked ? "linked" : "\u203a"));
      row.addEventListener("click", async () => {
        buzz(8);
        if (c.linked) {
          await unlinkMember(c.spaceId, c.memberId);
          toast(`${c.name} unlinked`, { icon: icon("users", 18) });
        } else {
          await linkMembers({ spaceId, memberId }, { spaceId: c.spaceId, memberId: c.memberId }, name);
          toast(`${name} and ${c.name} are the same person`, { icon: icon("users", 18) });
        }
        paint();
      });
      card.append(row);
    }
    wrap.append(card);

    if (contact) {
      wrap.append(el("button", {
        class: "btn btn-ghost btn-block", style: "margin-top:12px",
        onclick: async () => {
          await unlinkMember(spaceId, memberId);
          toast("Link removed", { icon: icon("users", 18) });
          paint();
        },
      }, `Unlink ${name} from everyone`));
    }
    if (back) {
      wrap.append(el("button", {
        class: "btn btn-primary btn-block", style: "margin-top:12px", onclick: back,
      }, "Done"));
    }
    anim(wrap.children, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28, ease: "power2.out" });
  }
}

/* ============================================================
   Create
   ============================================================ */

/** Name + colour, plus my display name the first time. Then the invite panel. */
export function createSpaceSheet() {
  openSheet("New shared space", (body) => {
    const panel = el("div", {});
    body.append(panel);
    paintForm();

    function paintForm() {
      panel.innerHTML = "";
      const me = profile();
      let color = "violet";
      let myColor = me?.color || "violet";

      const nameInput = el("input", { class: "input", type: "text", placeholder: "Home", maxlength: "40" });
      panel.append(el("div", { class: "field" },
        el("label", {}, "Space name"), nameInput,
        el("div", { class: "field-error" }, "Give it a name"),
      ));
      panel.append(el("div", { class: "field" },
        el("label", {}, "Colour"), colorPicker(SPACE_COLORS, color, (c) => { color = c; }),
      ));

      let myNameInput = null;
      if (!me?.name) {
        myNameInput = el("input", { class: "input", type: "text", placeholder: "Zubair", maxlength: "30" });
        panel.append(el("p", { class: "sp-hand" }, "One more thing — what should the others call you?"));
        panel.append(el("div", { class: "field" },
          el("label", {}, "Your name"), myNameInput,
          el("div", { class: "field-error" }, "Tell them who you are"),
        ));
        panel.append(el("div", { class: "field" },
          el("label", {}, "Your colour"), colorPicker(MEMBER_COLORS, myColor, (c) => { myColor = c; }),
        ));
      } else {
        panel.append(el("p", { class: "xsmall muted", style: "margin-bottom:12px" },
          `You'll join as ${esc(me.name)}. You can change that per space later.`));
      }

      const create = el("button", { class: "btn btn-primary btn-block" }, "Create space");
      panel.append(el("div", { class: "form-actions" }, create));
      create.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        const myName = (myNameInput ? myNameInput.value : me?.name || "").trim();
        nameInput.closest(".field").classList.toggle("has-error", !name);
        if (myNameInput) myNameInput.closest(".field").classList.toggle("has-error", !myName);
        if (!name || !myName) return;
        create.disabled = true;
        create.textContent = "Creating…";
        try {
          if (!me?.name || me.color !== myColor) await saveProfile({ name: myName, color: myColor });
          const space = await createSpace({ name, color, myName, myColor });
          paintInvite(space);
        } catch (err) {
          create.disabled = false;
          create.textContent = "Create space";
          toast(err?.message === "offline" ? "You're offline — try again in a bit" : "Couldn't create that space",
            { icon: icon("alert", 18) });
        }
      });
    }

    function paintInvite(space) {
      panel.innerHTML = "";
      retitle(panel, `Invite to ${space.name}`);
      panel.append(invitePanel(space, { done: () => closeSheet() }));
      anim(panel.children, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: "power2.out" });
    }
  });
}

/* ============================================================
   Invite
   ============================================================ */

/** The invite body — QR, the code with Copy, and Share. Used inline and alone. */
export function invitePanel(space, { done = null } = {}) {
  const code = inviteCodeFor(space);
  const link = inviteLink(code);
  const wrap = el("div", { class: "sp-invite" });

  wrap.append(el("div", { class: "sp-qr", html: qrSvg(code, { label: `Invite code for ${space.name}` }) }));

  const field = el("input", {
    class: "input sp-code", type: "text", readonly: true, value: code,
    "aria-label": "Invite code", id: "sp-invite-code",
    onclick: (e) => e.target.select(),
  });
  wrap.append(el("div", { class: "field" }, el("label", { for: "sp-invite-code" }, "Invite code"), field));

  const row = el("div", { class: "form-actions" });
  row.append(el("button", {
    class: "btn btn-ghost", html: `${icon("copy", 16)} Copy`,
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        field.select();
        document.execCommand && document.execCommand("copy");
      }
      toast("Invite copied", { icon: icon("check-circle", 18) });
    },
  }));
  if (navigator.share) {
    row.append(el("button", {
      class: "btn btn-ghost", html: `${icon("share", 16)} Share`,
      onclick: () => navigator.share({ title: `Join ${space.name} on Batwa`, url: link }).catch(() => {}),
    }));
  }
  wrap.append(row);
  wrap.append(el("p", { class: "xsmall muted", style: "margin-top:12px" },
    "Anyone with this code can read and write this space. Share it in person, not in a group chat."));
  if (done) wrap.append(el("button", { class: "btn btn-primary btn-block", style: "margin-top:12px", onclick: done }, "Done"));
  return wrap;
}

export function inviteSheet(space) {
  openSheet(`Invite to ${space.name}`, (body) => body.append(invitePanel(space)));
}

/* ============================================================
   Join
   ============================================================ */

const JOIN_ERRORS = {
  "bad-code": "That invite isn't valid",
  expired: "This invite has expired, ask for a new one",
  gone: "That space no longer exists",
  offline: "You're offline — join once you're back on the network",
};

/**
 * Paste or scan, then an inline confirm showing the decrypted space name and
 * who is already in it. `code` pre-fills the field (the `?join=` deep link).
 */
export function joinSpaceSheet({ code = "" } = {}) {
  openSheet("Join a space", (body) => {
    const panel = el("div", {});
    body.append(panel);
    paintPaste(code);

    function paintPaste(prefill) {
      panel.innerHTML = "";
      const input = el("textarea", {
        class: "input sp-code", rows: "3", placeholder: "Paste the invite code",
        "aria-label": "Invite code", spellcheck: "false",
      });
      input.value = prefill || "";
      const err = el("p", { class: "sp-err", hidden: true });
      panel.append(
        el("div", { class: "field" }, el("label", {}, "Invite code"), input),
        err,
      );

      const actions = el("div", { class: "form-actions" });
      if (window.BarcodeDetector) {
        actions.append(el("button", {
          class: "btn btn-ghost", html: `${icon("camera", 16)} Scan`,
          onclick: () => paintScan(),
        }));
      }
      const go = el("button", { class: "btn btn-primary", html: "Continue" });
      actions.append(go);
      panel.append(actions);

      go.addEventListener("click", async () => {
        const raw = extractCode(input.value);
        if (!raw) { show(err, JOIN_ERRORS["bad-code"]); return; }
        go.disabled = true;
        go.textContent = "Checking…";
        try {
          const preview = await previewInvite(raw);
          paintConfirm(preview);
        } catch (e) {
          go.disabled = false;
          go.textContent = "Continue";
          show(err, JOIN_ERRORS[e?.message] || JOIN_ERRORS["bad-code"]);
        }
      });
      setTimeout(() => { if (!prefill) input.focus(); }, 120);
    }

    /** Camera scan where BarcodeDetector exists; a plain fallback where it doesn't. */
    async function paintScan() {
      panel.innerHTML = "";
      const video = el("video", { class: "sp-scan", autoplay: "", muted: "", playsinline: "" });
      const err = el("p", { class: "sp-err", hidden: true });
      panel.append(video, err, el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost btn-block", onclick: () => { stop(); paintPaste(""); } }, "Type it instead")));

      let stream = null;
      let timer = null;
      const stop = () => {
        clearInterval(timer);
        try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
        stream = null;
      };
      panel.addEventListener("sp-teardown", stop, { once: true });

      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        timer = setInterval(async () => {
          try {
            const found = await detector.detect(video);
            const hit = found.find((f) => extractCode(f.rawValue));
            if (!hit) return;
            stop();
            const preview = await previewInvite(extractCode(hit.rawValue));
            paintConfirm(preview);
          } catch (e) {
            if (e && JOIN_ERRORS[e.message]) { stop(); show(err, JOIN_ERRORS[e.message]); }
          }
        }, 400);
      } catch {
        stop();
        show(err, "Batwa couldn't open the camera — paste the code instead");
      }
    }

    function paintConfirm(preview) {
      panel.dispatchEvent(new CustomEvent("sp-teardown"));
      panel.innerHTML = "";
      retitle(panel, `Join ${preview.blob.name}`);
      const { blob, alreadyMember, existing } = preview;
      const live = blob.members.filter((m) => !m.leftAt);

      panel.append(el("div", { class: "sp-confirm-head", style: `--sp:${colorHex(blob.color)}` },
        el("span", { class: "sp-strip" }),
        el("span", { class: "sp-confirm-name" }, blob.name),
        el("span", { class: "xsmall muted" },
          live.length ? `with ${live.map((m) => m.name).join(", ")}` : "You'd be the first one in"),
      ));

      if (alreadyMember) {
        // Same space, possibly new keys: a rotated invite heals the bundle in
        // place rather than adding me a second time (plan §8 and §9.20).
        const stale = existing.token !== preview.invite.token || existing.key !== preview.invite.key;
        panel.append(el("p", { class: "muted", style: "margin:12px 0" },
          stale
            ? "You're already in this space — this is a fresh code after a rotate."
            : "You're already in this space."));
        const open = el("button", { class: "btn btn-primary btn-block" },
          stale ? `Reconnect to ${blob.name}` : `Open ${blob.name}`);
        open.addEventListener("click", async () => {
          open.disabled = true;
          try { await adoptInvite(preview); } catch {}
          closeSheet();
          setTimeout(() => import("../app.js").then((m) => m.go("space", { id: existing.id })), 220);
        });
        panel.append(open);
        return;
      }

      const me = profile();
      let myColor = me?.color || "violet";
      const suggested = suggestName(blob, existing?.myName || me?.name || "");
      const nameInput = el("input", { class: "input", type: "text", maxlength: "30", placeholder: "Your name" });
      nameInput.value = suggested;
      const err = el("p", { class: "sp-err", hidden: true });
      panel.append(el("div", { class: "field" }, el("label", {}, "Your name in this space"), nameInput, err));
      panel.append(el("div", { class: "field" }, el("label", {}, "Your colour"),
        colorPicker(MEMBER_COLORS, myColor, (c) => { myColor = c; })));

      nameInput.addEventListener("input", () => {
        if (nameTaken(blob, nameInput.value, existing?.myMemberId)) {
          show(err, `${nameInput.value.trim()} is taken — try ${suggestName(blob, nameInput.value)}`);
        } else err.hidden = true;
      });

      const join = el("button", { class: "btn btn-primary btn-block" }, `Join ${blob.name}`);
      panel.append(el("div", { class: "form-actions" }, join));
      join.addEventListener("click", async () => {
        const displayName = nameInput.value.trim();
        if (!displayName) { show(err, "Pick a name the others will recognise"); return; }
        if (nameTaken(blob, displayName, existing?.myMemberId)) {
          show(err, `${displayName} is taken — try ${suggestName(blob, displayName)}`);
          return;
        }
        join.disabled = true;
        join.textContent = "Joining…";
        try {
          if (!me?.name) await saveProfile({ name: displayName, color: myColor });
          const space = await joinSpace(preview, { displayName, color: myColor });
          closeSheet();
          toast(`You're in ${space.name}`, { icon: icon("check-circle", 18) });
          setTimeout(() => import("../app.js").then((m) => m.go("space", { id: space.id })), 220);
        } catch (e) {
          join.disabled = false;
          join.textContent = `Join ${blob.name}`;
          show(err, JOIN_ERRORS[e?.message] || "Couldn't join — try again");
        }
      });
      anim(panel.children, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, stagger: 0.04, ease: "power2.out" });
    }
  }, { onDismiss: () => {} });
}

function show(node, text) {
  node.textContent = text;
  node.hidden = false;
}

/** Accept a bare code, a `?join=` link, or a code with stray whitespace. */
export function extractCode(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const fromUrl = text.match(/[?&]join=([A-Za-z0-9_-]+)/);
  const candidate = (fromUrl ? fromUrl[1] : text).replace(/\s+/g, "");
  return /^[A-Za-z0-9_-]{40,}$/.test(candidate) ? candidate : "";
}

/* ============================================================
   Per-space settings
   ============================================================ */

/** Rename, members, invite, rotate, leave — all inline panels of one sheet. */
export function spaceSettingsSheet(id, { onGone = null } = {}) {
  const space = getSpace(id);
  if (!space) return;
  openSheet(space.name, (body) => {
    const panel = el("div", {});
    body.append(panel);
    paintMain();

    function paintMain() {
      panel.innerHTML = "";
      const current = getSpace(id);
      if (!current) { closeSheet(); return; }
      retitle(panel, current.name);
      const st = spaceStatus(id);
      if (st !== "ok") {
        panel.append(el("div", { class: "warn-card", style: "margin-bottom:12px",
          html: `${icon("alert", 15)} ${esc(STATUS_TEXT[st] || "")}` }));
      }
      // A space that was closed on the relay, or whose invite no longer opens
      // it, can only be let go of (plan 9.30). Leaving would try to write to a
      // space that is not there; this just forgets it locally.
      if (st === "gone" || st === "expired") {
        panel.append(el("button", {
          class: "btn btn-soft-danger btn-block", style: "margin-bottom:14px",
          html: `${icon("trash", 16)} Remove from this phone`,
          onclick: async () => {
            const name = getSpace(id)?.name || "that space";
            await forgetSpace(id);
            closeSheet();
            toast(`Removed ${name}`, { icon: icon("check-circle", 18) });
            onGone && onGone();
          },
        }));
      }

      let color = current.color;
      const nameInput = el("input", { class: "input", type: "text", maxlength: "40", value: current.name });
      panel.append(el("div", { class: "field" }, el("label", {}, "Space name"), nameInput));
      panel.append(el("div", { class: "field" }, el("label", {}, "Colour"),
        colorPicker(SPACE_COLORS, color, (c) => { color = c; })));
      panel.append(el("button", {
        class: "btn btn-primary btn-block",
        onclick: async () => {
          const name = nameInput.value.trim();
          if (!name) return;
          await renameSpace(id, { name, color });
          toast("Space updated", { icon: icon("check-circle", 18) });
          paintMain();
        },
      }, "Save"));

      panel.append(el("h3", { class: "sp-subhead" }, "Members"));
      const list = el("div", { class: "sp-members" });
      const stale = new Set(staleIn(id).map((m) => m.memberId));
      const waiting = new Set(pendingRotation(id).map((m) => m.memberId));
      for (const m of membersOf(id)) {
        const me = m.memberId === current.myMemberId;
        const link = !me && !m.leftAt ? contactOf(id, m.memberId) : null;
        // Tapping a member is how the "Same person as..." list is reached
        // (plan section 8). My own row is not a link target: I am not in two
        // spaces as two different people.
        const row = el(me || m.leftAt ? "div" : "button", {
          class: `sp-member ${me || m.leftAt ? "" : "sp-member-btn"}`,
          type: me || m.leftAt ? undefined : "button",
          onclick: me || m.leftAt ? undefined : () => {
            buzz(6);
            panel.innerHTML = "";
            panel.append(memberLinkPanel(id, m.memberId, { back: paintMain, retitleIn: panel }));
          },
        });
        row.append(el("span", { class: "sp-av", style: `background:${colorHex(m.color, MEMBER_COLORS)}` }, initialsOf(m.name)));
        const sub = me ? "You"
          : m.leftAt ? "Left"
            : link ? `Same person as in ${link.links.filter((l) => l.spaceId !== id).map((l) => getSpace(l.spaceId)?.name).filter(Boolean).join(", ") || "another space"}`
              : stale.has(m.memberId) ? `Inactive \u2014 no activity in ${STALE_DAYS} days`
                : "Member";
        row.append(el("span", { class: "grow", style: me || m.leftAt ? "" : "text-align:left" },
          el("span", { class: "strong small", style: "display:block" }, m.name),
          el("span", { class: "xsmall muted" }, sub)));
        if (m.leftAt) row.append(el("span", { class: "badge badge-once" }, "left"));
        else if (waiting.has(m.memberId)) row.append(el("span", { class: "badge badge-once" }, "needs invite"));
        else if (stale.has(m.memberId)) row.append(el("span", { class: "badge badge-once" }, "inactive"));
        else if (!me) row.append(el("span", { class: "chev" }, "\u203a"));
        list.append(row);
      }
      if (!list.children.length) list.append(el("p", { class: "xsmall muted" }, "Nobody yet."));
      panel.append(list);

      panel.append(el("h3", { class: "sp-subhead" }, "Notifications"));
      panel.append(switchRow(
        "Show details in notifications",
        current.notifDetails !== false,
        (on) => {
          setNotifDetails(id, on);
          toast(on ? "Details will show in notifications" : "Only a generic alert now",
            { icon: icon("bell", 18) });
        },
        "On, this space's notification key is kept on this phone outside your PIN lock so the banner can say what happened. Off, every alert for this space just reads \u201cNew activity\u201d.",
      ));

      panel.append(el("h3", { class: "sp-subhead" }, "Invite"));
      // After a rotate, every OLD invite is dead. Each phone stamps its own
      // sawRotation when it re-joins, so this list shrinks by itself and is
      // the honest answer to "who have I not sent the new code to yet".
      const owed = pendingRotation(id);
      if (owed.length) {
        panel.append(el("div", {
          class: "warn-card sp-rotate-owed", style: "margin-bottom:10px",
          html: `${icon("key", 15)} Still needs the new invite: <b>${esc(owed.map((m) => m.name).join(", "))}</b>`,
        }));
      } else if (rotatedAt()) {
        panel.append(el("div", {
          class: "ok-card sp-rotate-owed", style: "margin-bottom:10px",
          html: `${icon("check-circle", 15)} Everyone is back on the new invite`,
        }));
      }
      panel.append(el("div", { class: "stack" },
        el("button", { class: "btn btn-ghost btn-block", html: `${icon("qr-code", 16)} Show invite code`,
          onclick: () => {
            retitle(panel, `Invite to ${getSpace(id).name}`);
            paintPanel(invitePanel(getSpace(id), { done: paintMain }));
          } }),
        el("button", { class: "btn btn-ghost btn-block", html: `${icon("key", 16)} Rotate invite`,
          onclick: () => paintRotate() }),
      ));

      panel.append(el("h3", { class: "sp-subhead" }, "Storage"));
      panel.append(storageBlock());

      panel.append(el("h3", { class: "sp-subhead" }, "Leaving"));
      panel.append(el("button", {
        class: "btn btn-soft-danger btn-block", html: `${icon("log-out", 16)} Leave this space`,
        onclick: () => paintLeave(),
      }));
    }

    function rotatedAt() {
      return blobOf(id)?.rotatedAt || null;
    }

    /** The size line, and the Compact button when there is anything to fold. */
    function storageBlock() {
      const info = compactionFor(id);
      const wrap = el("div", { class: "card sp-storage" });
      const kb = Math.max(1, Math.round(info.bytes / 1024));
      wrap.append(el("p", { class: "xsmall muted", style: "margin:0 0 8px" },
        `This space is about ${kb} KB. Everything in it is merged by every phone on every pull.`));
      if (!info.due) {
        wrap.append(el("p", { class: "xsmall muted", style: "margin:0" },
          "Nothing to compact yet \u2014 history is folded away once it is six months old and fully settled."));
        return wrap;
      }
      wrap.append(el("p", { class: "small", style: "margin:0 0 10px" },
        info.reason === "size"
          ? `It has grown past half a megabyte. ${info.count} older ${info.count === 1 ? "entry is" : "entries are"} fully settled and can be folded into running totals.`
          : `${info.count} ${info.count === 1 ? "entry" : "entries"} from before ${info.month} ${info.count === 1 ? "is" : "are"} fully accepted and settled.`));
      wrap.append(el("button", {
        class: "btn btn-ghost btn-block sp-compact-btn",
        html: `${icon("archive", 16)} Compact older history`,
        onclick: () => paintCompact(info),
      }));
      return wrap;
    }

    function paintCompact(info) {
      const plan = compactionPreview(id, info.month);
      const wrap = el("div", { class: "sp-compact-panel" });
      retitle(panel, "Compact");
      wrap.append(el("h3", { class: "sp-panel-title" }, `Fold away everything before ${info.month}?`));
      wrap.append(el("p", { class: "muted", style: "margin-bottom:10px" },
        `${plan.removed.length} settled ${plan.removed.length === 1 ? "entry" : "entries"} leave the shared document and are replaced by one running total per pair of people. Everybody's balance stays exactly the same to the rupee.`));
      wrap.append(el("p", { class: "sp-hand", style: "margin-bottom:14px" },
        "Your own copy keeps the detail \u2014 Records and History on this phone read it from an encrypted archive that never leaves here."));
      const confirm = el("button", { class: "btn btn-primary btn-block" }, "Compact now");
      wrap.append(el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: paintMain }, "Cancel"), confirm));
      confirm.addEventListener("click", async () => {
        confirm.disabled = true;
        confirm.textContent = "Compacting\u2026";
        const res = await compactSpace(id, info.month);
        toast(res && res.removed
          ? `${res.removed} older ${res.removed === 1 ? "entry" : "entries"} folded away`
          : "Nothing to compact", { icon: icon("archive", 18) });
        paintMain();
      });
      paintPanel(wrap);
    }

    function paintPanel(node) {
      panel.innerHTML = "";
      panel.append(node);
      anim(panel.children, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28, ease: "power2.out" });
    }

    function paintRotate() {
      const wrap = el("div", {});
      retitle(panel, "Rotate invite");
      wrap.append(el("h3", { class: "sp-panel-title" }, "A brand-new code for everyone"));
      wrap.append(el("p", { class: "muted", style: "margin-bottom:16px" },
        "Every old invite stops working straight away. Everyone still in the space needs the new code, including your other phone."));
      const confirm = el("button", { class: "btn btn-danger btn-block" }, "Rotate now");
      wrap.append(el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: paintMain }, "Cancel"), confirm));
      confirm.addEventListener("click", async () => {
        confirm.disabled = true;
        confirm.textContent = "Rotating…";
        try {
          await rotateSpace(id);
          toast("Invite rotated — send the new code", { icon: icon("key", 18) });
          retitle(panel, `Invite to ${getSpace(id).name}`);
          paintPanel(invitePanel(getSpace(id), { done: paintMain }));
        } catch {
          confirm.disabled = false;
          confirm.textContent = "Rotate now";
          toast("Couldn't rotate — try again when you're online", { icon: icon("alert", 18) });
        }
      });
      paintPanel(wrap);
    }

    function paintLeave() {
      const current = getSpace(id);
      const others = membersOf(id).filter((m) => m.memberId !== current.myMemberId && !m.leftAt);
      const wrap = el("div", {});
      retitle(panel, "Leave");
      wrap.append(el("h3", { class: "sp-panel-title" }, `Leave ${current.name}?`));
      wrap.append(el("p", { class: "muted", style: "margin-bottom:16px" },
        others.length
          ? "The others keep the space and see you as left. Anything you already accepted stays in your own ledger."
          : "You're the last one in, so the space is deleted from the relay as well."));
      const confirm = el("button", { class: "btn btn-danger btn-block" }, "Leave");
      wrap.append(el("div", { class: "form-actions" },
        el("button", { class: "btn btn-ghost", onclick: paintMain }, "Stay"), confirm));
      confirm.addEventListener("click", async () => {
        confirm.disabled = true;
        confirm.textContent = "Leaving…";
        await leaveSpace(id);
        closeSheet();
        toast(`Left ${current.name}`, { icon: icon("log-out", 18) });
        onGone && onGone();
      });
      paintPanel(wrap);
    }
  });
}

/* ============================================================
   Settings > Shared spaces
   ============================================================ */

/**
 * The Settings section. It is the only shared surface that exists with zero
 * spaces, because it is where the first one is made — with no space data on it
 * until there is a space (plan §0).
 */
export function renderSpacesSettings(view, { refresh }) {
  const g = el("div", { class: "set-group" });
  // Creating, joining or leaving repaints this list in place. The listener
  // unhooks itself the first time it fires against a detached view, so a
  // re-rendered Settings screen never leaves a second one behind.
  // Only the reasons that change what this list SAYS — a background pull or a
  // push must not re-render Settings under the user's thumb (plan §9.29).
  const STRUCTURAL = new Set(["created", "joined", "left", "renamed", "forgotten", "adopted", "rotated", "status"]);
  const off = onSpacesChange(({ reason }) => {
    if (!g.isConnected) { off(); return; }
    if (STRUCTURAL.has(reason)) refresh();
  });
  g.append(el("h2", {}, "Shared spaces"));
  const card = el("div", { class: "card set-card" });

  for (const s of spaces()) {
    const st = spaceStatus(s.id);
    const members = membersOf(s.id).filter((m) => !m.leftAt).length;
    const row = el("button", {
      class: "set-row",
      onclick: () => spaceSettingsSheet(s.id, { onGone: refresh }),
    });
    row.innerHTML = `
      <span class="set-ico" style="background:${colorHex(s.color)}22;color:${colorHex(s.color)}">${icon("users", 18)}</span>
      <span>${esc(s.name)}</span>
      <span class="set-val">${st === "ok" ? `${members} member${members === 1 ? "" : "s"}` : esc(STATUS_SHORT[st] || "")}</span>`;
    card.append(row);
  }

  const add = (key, label, onClick) => {
    const r = el("button", { class: "set-row", onclick: onClick });
    r.innerHTML = `
      <span class="set-ico" style="background:var(--c-violet-soft);color:var(--c-violet)">${icon(key, 18)}</span>
      <span>${label}</span><span class="chev">›</span>`;
    card.append(r);
  };
  add("plus", "New space", () => createSpaceSheet());
  add("user-plus", "Join with a code", () => joinSpaceSheet());
  g.append(card);

  // The master notification toggle, painted asynchronously the way the
  // Reminders row is: the browser's real answer beats the stored flag.
  let notifySlot = null;
  if (spaces().length) {
    const notifyCard = el("div", { class: "card set-card", style: "margin-top:12px" });
    notifySlot = el("button", { class: "set-row" });
    notifySlot.innerHTML = notifyRowHtml("…");
    notifyCard.append(notifySlot);
    g.append(notifyCard);
  }

  g.append(el("p", { class: "xsmall muted", style: "margin-top:8px;padding:0 4px" },
    relayConfigured()
      ? "A shared space is an encrypted document on a relay that only stores ciphertext: never names, amounts or who is who. The keys live in this ledger, behind your PIN, and travel in your backups."
      : "Shared spaces need a relay URL in js/config.js. Until one is set, this stays local."));
  if (spaces().length) {
    g.append(el("p", { class: "xsmall muted", style: "margin-top:6px;padding:0 4px" },
      "While notifications are on, each space's id and write token are also kept on this phone outside your PIN lock, so Batwa can check for new activity in the background. Turning notifications off deletes them again."));
  }
  view.append(g);
  // Only now is the row in the document; paintNotifyRow reads the browser's
  // real state and refuses to touch a detached node.
  if (notifySlot) paintNotifyRow(notifySlot, refresh);
}

/* ---- the "Notify me" master toggle (plan §7.1, §7.4) ---- */

const NOTIFY_STATE_TEXT = {
  on: "On",
  off: "Off",
  denied: "Blocked",
  "not-installed": "Unavailable",
  unavailable: "Unavailable",
};

function notifyRowHtml(value) {
  return `
    <span class="set-ico" style="background:var(--c-warn-soft);color:var(--c-warn)">${icon("bell", 18)}</span>
    <span>Notify me</span>
    <span class="set-val">${esc(value)}</span>`;
}

/**
 * Permission can be revoked from the browser behind our back and an iPhone
 * only gets push once Batwa is installed, so the real state is re-read on
 * every paint rather than trusting the stored flag alone.
 */
async function paintNotifyRow(slot, refresh) {
  if (!slot.isConnected) return;
  const st = await spacePushState();
  if (!slot.isConnected) return;
  slot.innerHTML = notifyRowHtml(NOTIFY_STATE_TEXT[st] || "Unavailable");
  slot.disabled = st !== "on" && st !== "off";

  if (st === "off") {
    slot.onclick = async () => {
      slot.disabled = true;
      const res = await enableSpacePush();
      slot.disabled = false;
      if (!res.ok) {
        toast(res.reason || "Couldn't turn notifications on", { icon: icon("alert", 18) });
        refresh();
        return;
      }
      toast(res.mode === "periodic"
        ? "Notifications are on \u2014 checked in the background"
        : "Notifications are on", { icon: icon("bell", 18) });
      await showPrivacyCopy(slot);
      paintNotifyRow(slot, refresh);
    };
  } else if (st === "on") {
    slot.onclick = async () => {
      slot.disabled = true;
      await disableSpacePush();
      toast("Notifications are off", { icon: icon("bell", 18) });
      slot.disabled = false;
      paintNotifyRow(slot, refresh);
    };
  } else {
    slot.onclick = null;
  }

  slot.nextElementSibling?.classList.contains("sp-notify-note") && slot.nextElementSibling.remove();
  const note = st === "not-installed"
    ? "Install Batwa to the home screen first \u2014 iOS and Chrome only deliver notifications to an installed app."
    : st === "denied"
      ? "Notifications are blocked for Batwa. Allow them in your browser or phone settings, then come back."
      : "";
  if (note) {
    slot.insertAdjacentElement("afterend", el("div", {
      class: "sp-notify-note", style: "padding:0 16px 12px",
    }, el("p", { class: "xsmall muted" }, note)));
  }
}

/**
 * The §7.4 privacy line, shown once: an inline note under the toggle the first
 * time it is turned on, dismissible, and remembered in meta `pushCopySeen`.
 */
async function showPrivacyCopy(slot) {
  let seen = false;
  try { seen = !!(await getMeta("pushCopySeen")); } catch {}
  if (seen || !slot.isConnected) return;
  const wrap = el("div", { class: "sp-notify-copy", style: "padding:2px 16px 14px" });
  const close = el("button", {
    class: "icon-btn", "aria-label": "Got it",
    style: "background:transparent;border:none;box-shadow:none;width:28px;height:28px;flex:0 0 auto;color:var(--c-muted)",
    html: icon("x", 14),
    onclick: async () => {
      try { await setMeta("pushCopySeen", true); } catch {}
      wrap.remove();
    },
  });
  wrap.append(el("div", { style: "display:flex;gap:8px;align-items:flex-start" },
    el("p", { class: "xsmall muted", style: "flex:1" },
      "To show details while Batwa is closed, a notification key for each space is kept on this phone outside your PIN lock. It can only decrypt notification summaries, never your ledger or the space itself. Turn off \u201cShow details\u201d in a space to keep only a generic alert."),
    close));
  slot.insertAdjacentElement("afterend", wrap);
  anim(wrap, { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" });
}

/* ============================================================
   Deep link
   ============================================================ */

/** `?join=<code>` after unlock, the same way `?action=` is handled. */
export function openJoinFromLink(code) {
  if (sheetOpen()) closeSheet();
  setTimeout(() => joinSpaceSheet({ code }), sheetOpen() ? 260 : 0);
}

/** Pull one space and repaint whatever is listening. Used by the space view. */
export const refreshSpace = (id) => pullSpace(id);
export { renameMe, setNotifDetails, forgetSpace };

/**
 * "Same person as…" as a sheet of its own, for surfaces that are not already
 * inside one (the space screen's balances and its canopy member stack).
 */
export function memberLinkSheet(spaceId, memberId, { onChanged = null } = {}) {
  openSheet("Same person as…", (body) => {
    body.append(memberLinkPanel(spaceId, memberId, {
      back: () => { closeSheet(); onChanged && onChanged(); },
    }));
  });
}
