/* wssnoop/minibuffer — a one-line status strip that echoes the hovered button's
 * tooltip. Reads `hoverTitle` in a thunk so it repaints as the pointer moves
 * across the toolbar; falls back to a static hint when nothing is hovered. */

import { Box, Text, italic, fg } from "yeet:tui";

import { hoverTitle } from "../controls.js";
import { COL } from "./palette.js";

const HINT = "hover a control for help · q / Ctrl-C to quit";

export default function Minibuffer() {
  return (
    <Box height={1} overflow="hidden">
      <Text break="none">
        {/* explicit fg — a bare dim() would inherit the terminal default fg and
            vanish against the dark surface */}
        {() => {
          const t = hoverTitle.get();
          return t ? fg(COL.dim)(t) : italic(fg(COL.header)(HINT));
        }}
      </Text>
    </Box>
  );
}
