/* minibuffer — a one-line status strip that echoes the hover bus. Kit-generic:
 * reads `hoverTitle`/`toast` from the tooltip bus and repaints as the pointer
 * moves; falls back to a static `hint` when nothing is hovered.
 *
 * `hint` is the resting text (the app's cheat sheet). `priority` is an optional
 * source (a signal or a thunk) yielding a string | thunk | null that WINS over
 * the hover tooltip when set — for a readout that competes with the plain tip
 * (wssnoop passes the sparkline's per-column crosshair readout). Precedence:
 * toast > priority > hoverTitle > hint. */

import { Box, Text, face } from "yeet:tui";

import { hoverTitle, toast } from "./tooltip.js";
import { theme } from "./theme.js";

const read = (src) => (src == null ? null : typeof src.get === "function" ? src.get() : src());

export default function Minibuffer({ hint = "", priority }) {
  return (
    <Box height={1} overflow="hidden">
      <Text break="none">
        {() => {
          const flash = toast.get();
          if (flash) return face({ fg: theme.accent })(flash);
          const t = read(priority) ?? hoverTitle.get();
          const text = typeof t === "function" ? t() : t; // titles are stored unresolved
          return text ? face({ fg: theme.dim })(text) : face({ fg: theme.header, italic: true })(hint);
        }}
      </Text>
    </Box>
  );
}
