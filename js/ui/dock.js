// The floating dock's scroll behaviour: labels collapse on the way down and
// come back on the way up, so the thumb zone gets out of the way of a long
// list without the dock ever leaving the screen.

let nav = null;

export function expandDock() {
  nav = nav || document.querySelector(".bottom-nav");
  if (nav) nav.classList.remove("is-compact");
}

export function initDock() {
  nav = document.querySelector(".bottom-nav");
  if (!nav) return;
  let last = 0, raf = 0;

  const onScroll = (ev) => {
    const t = ev.target === document || ev.target === window
      ? document.scrollingElement
      : ev.target;
    if (!t || (t.closest && t.closest(".sheet"))) return;   // sheets scroll internally
    if (t !== document.scrollingElement && !(t.classList && t.classList.contains("home-left"))) return;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const y = t.scrollTop;
      const dy = y - last;
      last = y;
      if (y < 40 || dy < -8) nav.classList.remove("is-compact");
      else if (dy > 8) nav.classList.add("is-compact");
    });
  };

  // capture, so the desktop .home-left column's own scroll is seen too
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
}
