// Inline category editor — the "+" beside a Category dropdown, and the same
// panel reused in Settings > Categories.
//
// It is an INLINE panel, never a sheet. openSheet() closes whatever sheet is
// already open (modals.js) and nesting leaves a stale history entry, so the
// editor has to live inside the form it belongs to — the same trick the
// account logo picker and the inline delete row use.

import { el, buzz, segmented, motionOK } from "../util/dom.js";
import {
  state, addCategory, updateCategory, findCategory, CATEGORY_MAX, RESERVED_CATEGORY,
} from "../ledger.js";
import { icon, catIconName, CATEGORY_ICONS, DEFAULT_CATEGORY_ICON } from "./icons.js";
import { toast } from "./toast.js";

const uid = () => "c" + Math.random().toString(36).slice(2, 8);

/**
 * The Category <select>. Tagged `data-cat` so every one of them in the open
 * sheet can be re-synced after a category is added or renamed — the quick-add
 * sheet holds an expense form and an income form at the same time.
 */
export function categorySelect(selected) {
  const sel = el("select", { class: "input", "data-cat": "1" });
  for (const c of state.categories) {
    sel.append(el("option", { value: c, selected: c === selected }, c));
  }
  return sel;
}

/**
 * Rebuild every category dropdown in the open sheet from state.categories,
 * preserving each one's current value. `from`/`to` carry a rename across, and
 * a value that no longer exists falls back to Others.
 */
export function syncCategorySelects({ from = null, to = null, only = null, pick = null } = {}) {
  const root = document.getElementById("sheet-root") || document;
  for (const sel of root.querySelectorAll("select.input[data-cat]")) {
    let val = sel.value;
    if (from && val === from) val = to;
    if (only && sel === only && pick) val = pick;
    sel.replaceChildren(...state.categories.map((c) => el("option", { value: c }, c)));
    sel.value = state.categories.includes(val) ? val : RESERVED_CATEGORY;
  }
}

const ERRORS = {
  empty: () => "Give it a name",
  reserved: () => `${RESERVED_CATEGORY} is reserved`,
  duplicate: (n) => `You already have ${n}`,
  missing: () => "That category is gone",
};

/**
 * The panel itself. Returns { node, open, close, isOpen, setTarget }.
 *
 * `getTarget()` names the category the Edit tab should work on.
 * `onSaved(name, { mode, from })` fires after a successful save.
 * `modes` limits the tab strip — Settings' row-edit opens with both, the
 * standalone "New category" button opens on "new".
 */
export function categoryEditorPanel({
  getTarget = () => RESERVED_CATEGORY,
  onSaved = () => {},
  onResize = null,
  onClose = null,
} = {}) {
  const node = el("div", { class: "cat-editor", hidden: true });

  let tab = "new";
  let busy = false;
  let target = RESERVED_CATEGORY;
  // typed text survives a tab flip, one draft per tab
  const drafts = {
    new: { name: "", icon: DEFAULT_CATEGORY_ICON, limit: "" },
    edit: { name: "", icon: DEFAULT_CATEGORY_ICON, limit: "" },
  };

  /* ---- pieces ---- */
  const segWrap = el("div", {});

  const nameId = uid();
  const nameInput = el("input", {
    class: "input", type: "text", id: nameId,
    maxlength: String(CATEGORY_MAX),
    autocapitalize: "words", autocomplete: "off", spellcheck: "false",
    placeholder: "Chai, Gym, Books…",
  });
  const nameField = el("div", { class: "field" },
    el("label", { for: nameId }, "Name"), nameInput);

  const grid = el("div", { class: "logo-grid" });
  const iconField = el("div", { class: "field" }, el("label", {}, "Icon"), grid);

  const limitId = uid();
  const limitInput = el("input", {
    class: "input input-sm", type: "text", id: limitId,
    inputmode: "numeric", autocomplete: "off", placeholder: "No limit",
  });
  const limitField = el("div", { class: "field" },
    el("label", { for: limitId }, "Monthly limit"),
    el("span", { class: "cat-limit-field" },
      el("span", { class: "cat-limit-cur" }, "Rs"), limitInput),
    el("p", { class: "hint" }, "Optional — leave blank for no limit"));

  const errNode = el("div", { class: "field-error cat-err" });
  const lockNote = el("p", { class: "hint cat-lock-note", hidden: true },
    `${RESERVED_CATEGORY} is the fallback category and cannot be renamed`);

  const saveBtn = el("button", { class: "btn btn-primary btn-sm", type: "button" }, "Save");
  const cancelBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Cancel");
  const actions = el("div", { class: "cat-editor-actions" }, cancelBtn, saveBtn);

  node.append(segWrap, nameField, iconField, limitField, lockNote, errNode, actions);

  /* ---- icon grid ---- */
  for (const name of CATEGORY_ICONS) {
    const b = el("button", {
      type: "button", class: "logo-opt cat-ico-opt", "data-ico": name,
      "aria-label": name.replace(/-/g, " "),
      html: icon(name, 22),
    });
    b.addEventListener("click", () => {
      drafts[tab].icon = name;
      buzz(6);
      paintIcons();
    });
    grid.append(b);
  }
  function paintIcons() {
    const on = drafts[tab].icon;
    for (const b of grid.children) b.classList.toggle("is-active", b.dataset.ico === on);
  }

  /* ---- errors ---- */
  function showErr(text) {
    errNode.textContent = text || "";
    errNode.classList.toggle("is-on", !!text);
    nameField.classList.toggle("has-error", !!text);
    if (text && motionOK()) {
      gsap.fromTo(node, { x: 0 }, { x: 6, duration: 0.05, repeat: 5, yoyo: true, clearProps: "x" });
    }
  }
  const clearErr = () => showErr("");

  /* ---- tabs ---- */
  const locked = () => tab === "edit" && target === RESERVED_CATEGORY;

  function applyTab() {
    const d = drafts[tab];
    nameInput.value = d.name;
    limitInput.value = d.limit;
    paintIcons();
    const lock = locked();
    nameInput.disabled = lock;
    limitInput.disabled = lock;
    nameField.classList.toggle("is-disabled", lock);
    limitField.classList.toggle("is-disabled", lock);
    lockNote.hidden = !lock;
    clearErr();
    resized();
  }

  function buildTabs() {
    const label = target.length > 12 ? `Edit "${target.slice(0, 11)}…"` : `Edit "${target}"`;
    const seg = segmented(
      [{ label: "New", value: "new" }, { label, value: "edit" }],
      tab,
      (v) => { tab = v; applyTab(); }
    );
    segWrap.replaceChildren(seg);
  }

  /* ---- resize hook: the quick-add pager caches page heights ---- */
  function resized() {
    node.dispatchEvent(new CustomEvent("cat-editor-resize", { bubbles: true }));
    onResize && onResize();
  }

  /* ---- open / close ---- */
  function open(mode = "new", name = null) {
    target = name || getTarget() || RESERVED_CATEGORY;
    tab = mode === "edit" ? "edit" : "new";
    // reopening always resets to the current selection — no stale half-edit
    drafts.new = { name: "", icon: DEFAULT_CATEGORY_ICON, limit: "" };
    drafts.edit = {
      name: target,
      icon: catIconName(target),
      limit: state.limits[target] ? String(state.limits[target]) : "",
    };
    buildTabs();
    applyTab();
    node.hidden = false;
    node.classList.add("is-open");
    resized();
    requestAnimationFrame(() => {
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (!nameInput.disabled) { try { nameInput.focus(); } catch {} }
    });
  }

  function close({ refocus = true } = {}) {
    if (node.hidden) return;
    node.hidden = true;
    node.classList.remove("is-open");
    clearErr();
    resized();
    onClose && onClose({ refocus });
  }

  const isOpen = () => !node.hidden;

  /* ---- input wiring ---- */
  nameInput.addEventListener("input", () => { drafts[tab].name = nameInput.value; clearErr(); });
  limitInput.addEventListener("input", () => {
    const clean = limitInput.value.replace(/[^0-9]/g, "");
    if (clean !== limitInput.value) limitInput.value = clean;
    drafts[tab].limit = clean;
    clearErr();
  });

  // Enter saves the CATEGORY, never the expense form around it; Escape closes
  // the panel only — the global Escape handler would otherwise close the sheet.
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  cancelBtn.addEventListener("click", () => { buzz(6); close(); });
  saveBtn.addEventListener("click", () => save());

  async function save() {
    if (busy) return;
    const d = drafts[tab];
    const mode = tab;
    const from = target;
    busy = true;
    saveBtn.disabled = true;
    try {
      if (mode === "new") {
        const name = await addCategory(d.name, { icon: d.icon, limit: d.limit });
        close({ refocus: false });
        toast(`Added ${name}`, { icon: icon(d.icon, 18) });
        onSaved(name, { mode, from: null });
      } else {
        const name = await updateCategory(from, {
          name: d.name, icon: d.icon, limit: d.limit === "" ? null : Number(d.limit),
        });
        close({ refocus: false });
        toast("Saved", { icon: icon(d.icon, 18) });
        onSaved(name, { mode, from });
      }
    } catch (err) {
      const typed = d.name.trim();
      const make = ERRORS[err.message];
      // name the category as it is actually stored: "You already have Food"
      showErr(make ? make(findCategory(typed) || typed) : "Couldn't save that");
      return;
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }

  return { node, open, close, isOpen, setTarget: (n) => { target = n; } };
}

/**
 * The whole Category field for a form: label, the select, the "+" button, and
 * the editor panel underneath. `onPick(name)` fires after any save.
 */
export function categoryField(selected, { onPick = null, label = "Category" } = {}) {
  const select = categorySelect(selected);
  select.id = uid();

  const plus = el("button", {
    type: "button",
    class: "icon-btn cat-plus",
    "aria-label": "New or edit category",
    "aria-expanded": "false",
    html: icon("plus", 18),
  });

  const row = el("div", { class: "cat-row" }, select, plus);
  const field = el("div", { class: "field" }, el("label", { for: select.id }, label), row);

  const panel = categoryEditorPanel({
    getTarget: () => select.value,
    onClose: ({ refocus }) => {
      plus.setAttribute("aria-expanded", "false");
      if (refocus) { try { plus.focus(); } catch {} }
    },
    onSaved: (name, { from }) => {
      syncCategorySelects({ from, to: name, only: select, pick: name });
      onPick && onPick(name);
    },
  });
  field.append(panel.node);

  plus.addEventListener("click", () => {
    buzz(8);
    if (panel.isOpen()) { panel.close(); return; }
    plus.setAttribute("aria-expanded", "true");
    panel.open("new");
  });

  return { field, select, panel, destroy: () => panel.close({ refocus: false }) };
}
