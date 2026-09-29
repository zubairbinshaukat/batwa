// Which space, and which month of it, the space view is looking at.
//
// Lives apart from js/ui/spaceview.js because js/app.js reads and sets it on
// the start-up path (go(), popstate, onSpacesChange) while the view itself is
// loaded on demand through js/ui/lazy.js. Keeping the state here means the
// router never has to wait for, or guess at, a module that isn't there yet.

import { thisMonth } from "../util/format.js";

let currentId = null;
let currentMonth = thisMonth();

export function setSpaceTarget(id) {
  if (id && id !== currentId) currentMonth = thisMonth();
  currentId = id || currentId;
}

export const spaceTarget = () => currentId;

/** The month the space view shows; the view's arrows move it. */
export const spaceMonth = () => currentMonth;
export function setSpaceMonth(month) { currentMonth = month; }
