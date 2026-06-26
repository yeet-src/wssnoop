/* wssnoop/minibuffer — a one-line status strip that echoes the hovered button's
 * tooltip. Reads `hoverTitle` in a thunk so it repaints as the pointer moves
 * across the toolbar; falls back to a static hint when nothing is hovered. */

import { Box, Text, italic, fg } from "yeet:tui";

import { hoverTitle, toast } from "../controls.js";
import { COL } from "./palette.js";

const HINT =
  "click a connection → inspect · decode · ⊙ focus the kernel · ⧉ copy fixtures    ·    / search · q quit";

export default function Minibuffer() {
  return (
    <Box height={1} overflow="hidden">
      <Text break="none">
        {/* toast (transient) wins over the hover tooltip, which wins over the
            static hint. Explicit fg — a bare dim() vanishes on the dark surface. */}
        {() => {
          const flash = toast.get();
          if (flash) return fg(COL.accent)(flash);
          const t = hoverTitle.get();
          return t ? fg(COL.dim)(t) : italic(fg(COL.header)(HINT));
        }}
      </Text>
    </Box>
  );
}
