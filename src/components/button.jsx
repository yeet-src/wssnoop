/* wssnoop/button — the one interactive primitive. A small padded box that
 * publishes its `title` to the shared `hoverTitle` signal on pointer-enter (the
 * minibuffer renders it) and clears it on leave; clicking runs `onClick` and
 * stops the event so it never trips a handler on the pane behind it. `active`
 * marks toggle / selected state (reverse+bold), local hover just brightens.
 *
 * The button knows nothing of the minibuffer — the tooltip is global state by
 * design (see controls.js), so the toolbar and the hint share one source.
 */

import { Box, Text, bold, fg, bg, signal } from "yeet:tui";

import { hoverTitle } from "../controls.js";
import { COL } from "./palette.js";

/* Children and `active` may be plain or thunks — the toolbar's labels and
 * toggle state are live, so we resolve both reactively. `label` reads its thunk
 * inside both the width and the content thunks so the box re-sizes in step. */
const asText = (c) => (Array.isArray(c) ? c.join("") : `${c ?? ""}`);

export default function Button({ title = "", onClick, active = false }, children) {
  const hovered = signal(false);
  const labelOf = typeof children === "function" ? () => asText(children()) : () => asText(children);
  const activeOf = typeof active === "function" ? active : () => active;
  return (
    <Box
      width={() => labelOf().length + 2} /* padding [0,1] on each side */
      padding={[0, 1]}
      height={1}
      onMouseEnter={() => hoverTitle.set(title)}
      onMouseLeave={() => hoverTitle.set("")}
      onClick={(e) => {
        onClick?.();
        e.stopPropagation();
      }}
      setHover={hovered}
    >
      <Text break="none">
        {() => {
          const l = labelOf();
          if (activeOf()) return bg(COL.accent)(fg(COL.ink)(bold(l)));
          if (hovered.get()) return bold(fg(COL.accent)(l));
          return fg(COL.dim)(l); /* explicit fg — bare dim() vanishes on the dark surface */
        }}
      </Text>
    </Box>
  );
}
