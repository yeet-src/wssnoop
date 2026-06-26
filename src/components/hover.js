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

export const hoverBg = (k) => computed(() => (key.get() === k ? COL.hover : undefined));

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
