// Toasts: one for every completed action, with optional Undo.

import { $, el, anim, animTo } from "../util/dom.js";

const DURATION = 3800;

export function toast(message, { undo, icon = "" } = {}) {
  const root = $("#toast-root");
  const t = el("div", { class: "toast", role: "status" });
  if (icon) t.append(el("span", { "aria-hidden": "true" }, icon));
  t.append(el("span", { class: "grow" }, message));

  let undone = false;
  let timer;

  const kill = () => {
    clearTimeout(timer);
    animTo(t, { opacity: 0, y: 14, duration: 0.25, ease: "power2.in", onComplete: () => t.remove() });
  };

  if (undo) {
    t.append(
      el("button", {
        class: "toast-undo",
        onclick: () => {
          if (undone) return;
          undone = true;
          undo();
          kill();
        },
      }, "Undo")
    );
  }

  // keep at most 2 visible
  while (root.children.length >= 2) root.firstChild.remove();
  root.append(t);
  anim(t, { opacity: 0, y: 18, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: "back.out(1.6)" });
  timer = setTimeout(kill, DURATION);
  return kill;
}
