/* wssnoop/minibuffer — a one-line status strip that echoes the hovered button's
 * tooltip. Reads `hoverTitle` in a thunk so it repaints as the pointer moves
 * across the toolbar; falls back to a static hint when nothing is hovered. */

import { Box, Text, face } from "yeet:tui";

import { hoverTitle, toast, cursorReadout } from "../controls.js";
import { theme } from "../ui/theme.js";

const HINT =
  "click a connection → inspect · decode · ⊙ focus the kernel · ⧉ copy fixtures    ·    / search · q quit";

export default function Minibuffer() {
  return (
    <Box height={1} overflow="hidden">
      <Text break="none">
        {/* toast (transient) wins over the hover tooltip, which wins over the
            static hint. The tooltip is stored unresolved (string | thunk) so a
            state-naming title stays live while hovered — resolve it here. */}
        {() => {
          const flash = toast.get();
          if (flash) return face({ fg: theme.accent })(flash);
          /* A bar's per-column readout (when the pointer is on a sparkline) wins
           * over the row tip the pointer also sits inside; then the plain tip. */
          const t = cursorReadout.get() ?? hoverTitle.get();
          const text = typeof t === "function" ? t() : t;
          return text ? face({ fg: theme.dim })(text) : face({ fg: theme.header, italic: true })(HINT);
        }}
      </Text>
    </Box>
  );
}
