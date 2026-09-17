// Whether money is on screen or blurred. Session-only: every launch starts
// hidden, nothing is persisted. Lives in its own module because the eye now
// governs far more than the hero — accounts, limits, upcoming cards and the
// month sheet all read the same flag.

let revealed = false;
const subs = new Set();

export const isRevealed = () => revealed;

export function setRevealed(v) {
  revealed = !!v;
  for (const f of subs) { try { f(revealed); } catch {} }
}

/** Subscribe; returns an unsubscribe. */
export function onReveal(f) {
  subs.add(f);
  return () => subs.delete(f);
}
