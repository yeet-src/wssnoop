/* hover — the shared "pointer is over a clickable" highlight. One module-level
 * key names whatever clickable the pointer rests on; a clickable spreads
 * `hoverTip(key, title)` (which both publishes its tooltip AND marks itself
 * hovered) and sets `bg={hoverBg(key)}` to light up. Keyed (not a per-node
 * boolean) so it survives nodes that re-mint every frame — the inspector's
 * message rows rebuild each heartbeat, yet their highlight holds.
 *
 * Buttons keep their own brighten-on-hover (a text face, not a bg); this is for
 * the plain clickable Boxes — connection rows, message rows, the focus chip. */

import { signal, computed } from "yeet:tui";

import { COL } from "./palette.js";
import { hoverTitle } from "../controls.js";

const key = signal(null);

/* `base` is the resting bg (default transparent); the element lights to
 * COL.hover under the pointer. Pass a base when the element must also be opaque
 * at rest (e.g. a top-bar item that mustn't let neighbours overlap it). */
export const hoverBg = (k, base) => computed(() => (key.get() === k ? COL.hover : base));

/* Is the pointer currently resting on element `k`? Read inside a render thunk
 * so it tracks: a side that emboldens itself on hover (see components/pair.jsx)
 * reads this to know which of a pair the pointer is over. */
export const hovered = (k) => key.get() === k;

/* Tooltip + highlight for a clickable element — use in place of `tip()` (it is
 * a superset). `t` may be a string or thunk, like `tip`. */
export const hoverTip = (k, t) => ({
  onMouseEnter: () => {
    hoverTitle.set(t);
    key.set(k);
  },
  onMouseLeave: () => {
    hoverTitle.set("");
    key.set(null);
  },
});
