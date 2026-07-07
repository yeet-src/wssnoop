/* tooltip — the hover-driven status bus for the UI kit. Three cooperating
 * pieces, all global by design so a widget feeds them without knowing the status
 * line, and every widget shares one source:
 *
 *   hoverTitle  what the pointer is over. A clickable publishes its tooltip on
 *               enter (`tip`/`hoverTip`) and clears it on leave; the Minibuffer
 *               echoes it. Stored *unresolved* (string | thunk) so a
 *               state-naming title stays live while hovered — the Minibuffer
 *               re-evaluates a thunk each frame.
 *   key         the shared "pointer is over this clickable" highlight. Keyed,
 *               not a per-node boolean, so it survives nodes that re-mint every
 *               frame (a live list's rows rebuild yet their highlight holds).
 *   toast       transient status ("copied 42 messages") shown over the tooltip
 *               for a moment, then cleared.
 *
 * Kit-generic: the app supplies no target — it just mounts a Minibuffer and
 * spreads tip()/hoverTip() on its clickables. */

import { signal, computed } from "yeet:tui";

import { theme } from "./theme.js";

/* Current tooltip (string | thunk), resolved by the Minibuffer. */
export const hoverTitle = signal("");

/* Spreadable hover-tooltip handlers for ANY widget: `<Box {...tip("…")}>`. `t`
 * may be a string or a thunk over live values. */
export const tip = (t) => ({
  onMouseEnter: () => hoverTitle.set(t),
  onMouseLeave: () => hoverTitle.set(""),
});

/* The shared highlight key. `base` is the resting bg (default transparent); the
 * element lights to the theme's hover role under the pointer. Pass a base when
 * the element must also be opaque at rest (e.g. a top-bar item that mustn't let
 * neighbours overlap it). */
const key = signal(null);
export const hoverBg = (k, base) => computed(() => (key.get() === k ? theme.hover : base));

/* Tooltip + highlight for a clickable element — a superset of `tip()`: use in
 * its place. `t` may be a string or thunk, like `tip`. */
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

/* Transient status line. Shown in the Minibuffer over the hover tooltip for a
 * moment, then clears itself. A token guards against an older flash clearing a
 * newer one. */
export const toast = signal("");
let toastN = 0;
export function flash(msg, ms = 2500) {
  toast.set(msg);
  const n = ++toastN;
  setTimeout(() => {
    if (n === toastN) toast.set("");
  }, ms);
}
