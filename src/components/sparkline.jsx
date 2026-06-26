/* wssnoop/sparkline — a connection's recent traffic as one row of half-block
 * cells. Each column is a wall-clock time bucket; the upper half of the glyph
 * (fg) is egress (UP / SSL_write), the lower half (bg) is ingress (DOWN /
 * SSL_read). Both halves heat-shade by that column's share of the window peak.
 *
 * It reads `now` and `span` in its OWN thunk, so it reflows on every clock tick
 * without the caller re-rendering — the sparkline is the only thing that needs
 * to repaint when wall time advances. `variant` picks the hue pair (see
 * lib/format.js) so a process or global aggregate reads as distinct from a
 * per-connection row. */

import { Box, Text, fg, bg } from "yeet:tui";

import { heatFor } from "../lib/format.js";
import { tip } from "../controls.js";

const GLYPH = "▀"; // upper half block: fg paints the top (egress), bg the bottom (ingress)

/* Default tooltips — the chart's meaning isn't self-evident, so each variant
 * explains itself in the minibuffer on hover. */
const TITLES = {
  conn: "connection traffic — bytes/sec per column; upper half = sent (egress), lower = received (ingress); brighter = more",
  agg: "process total — bytes/sec across all its connections; upper = sent, lower = received; brighter = more",
  global: "all processes — total bytes/sec; upper = sent, lower = received; brighter = more",
};

/* Magnitude → brightness within a fixed per-variant hue (see lib/format.js):
 * the upper half (fg) is egress, the lower half (bg) ingress, both shaded by
 * that column's share of the window peak. Idle cells (and any unfilled width)
 * sit on the explicit dark TRACK so the rail reads as one flat strip. */
export default function Sparkline({ hist, now, span, width, variant = "conn", title }) {
  const pal = heatFor(variant);
  return (
    <Box width={width} height={1} overflow="hidden" bg={pal.track} {...tip(title ?? TITLES[variant])}>
      <Text break="none">
        {() => {
          if (!hist) return "";
          const cols = Math.max(1, width | 0);
          const { up, down, peak } = hist.window(now.get(), span.get(), cols);
          const p = Math.max(1, peak);
          const cells = [];
          for (let c = 0; c < cols; c++) {
            const u = (up[c] ?? 0) / p;
            const d = (down[c] ?? 0) / p;
            cells.push(fg(pal.up(u))(bg(pal.down(d))(GLYPH)));
          }
          return cells;
        }}
      </Text>
    </Box>
  );
}
