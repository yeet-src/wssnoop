/* wssnoop/button — the one interactive primitive. A small padded box that
 * publishes its `title` to the shared `hoverTitle` signal on pointer-enter (the
 * minibuffer renders it) and clears it on leave; clicking runs `onClick` and
 * stops the event so it never trips a handler on the pane behind it. `active`
 * marks toggle / selected state (accent fill), hover lights the faint COL.hover.
 *
 * The button knows nothing of the minibuffer — the tooltip is global state by
 * design (see controls.js), so the toolbar and the hint share one source. Hover
 * is a local boolean: it persists because the buttons mount once (the inspector
 * is memoized in root, so its subtree no longer re-mints each heartbeat).
 */

import { Box, Text, face, signal, computed } from "yeet:tui";

import { hoverTitle } from "../controls.js";
import { COL } from "../palette.js";

/* Children and `active` may be plain or thunks — the toolbar's labels and
 * toggle state are live, so we resolve both reactively. `label` reads its thunk
 * inside both the width and the content thunks so the box re-sizes in step.
 * `title` is passed to `hoverTitle` unresolved (string or thunk) so a
 * state-naming tooltip stays live while hovered — the minibuffer resolves it. */
const asText = (c) => (Array.isArray(c) ? c.join("") : `${c ?? ""}`);

/* Separate the two concerns: the Box owns the background (so it fills the
 * padding too), the Text owns the ink. Background: active fills accent, a plain
 * hover lights the faint highlight (the same COL.hover the clickable rows use,
 * so buttons and rows read consistently), idle is transparent. Ink: explicit fg
 * on idle — a bare `dim` attr vanishes on the dark surface. */
const bgFor = (active, hovered) => (active ? COL.accent : hovered ? COL.hover : undefined);
const inkFor = (active, hovered) =>
  active ? { fg: COL.ink, bold: true } : hovered ? { fg: COL.accent, bold: true } : { fg: COL.dim };

export default function Button({ title = "", onClick, active = false }, children) {
  const hovered = signal(false);
  const labelOf = typeof children === "function" ? () => asText(children()) : () => asText(children);
  const activeOf = typeof active === "function" ? active : () => active;
  /* A computed (not a bare thunk) so the Box repaints its fill on hover/active
   * without re-minting — same reactive-bg pattern the clickable rows use. */
  const bg = computed(() => bgFor(activeOf(), hovered.get()));
  return (
    <Box
      width={() => labelOf().length + 2} /* padding [0,1] on each side */
      padding={[0, 1]}
      height={1}
      bg={bg}
      onMouseEnter={() => hoverTitle.set(title)}
      onMouseLeave={() => hoverTitle.set("")}
      onClick={(e) => {
        onClick?.();
        e.stopPropagation();
      }}
      setHover={hovered}
    >
      {/* face() applies a runtime-computed patch — the blessed escape hatch for
          dynamic styling, read inside the thunk so it tracks active/hover. */}
      <Text break="none">{() => face(inkFor(activeOf(), hovered.get()))(labelOf())}</Text>
    </Box>
  );
}
