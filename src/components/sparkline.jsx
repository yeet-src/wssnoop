/* wssnoop/sparkline — a connection's recent traffic as one row of half-block
 * cells. Each column is a wall-clock time bucket; the upper half of the glyph
 * (fg) is egress (UP / SSL_write), the lower half (bg) is ingress (DOWN /
 * SSL_read). Both halves heat-shade by that column's share of the window peak.
 *
 * Rendered into a CellBuffer, not <Text>: there are ~13 sparklines, each ~120
 * cells, each repainting every heartbeat. A <Text> path would mint a styled Run
 * per cell every tick — thousands of short-lived objects/sec that outran GC and
 * OOM'd the (memory-limited) V8 isolate within a minute. The CellBuffer writes
 * color ints straight into reused plane views (`heatFor`'s ramps return ints,
 * and "▀" is a single code point), so a redraw allocates essentially nothing.
 *
 * Redraw is driven by a timer, not by reading `now` in a thunk: the draw calls
 * cb.touch() (a Signal set), which can't happen during graph evaluation — so it
 * must run from a timer callback, outside the render. An Effect owns the timer's
 * lifecycle (start on mount, clear on unmount). `variant` picks the hue pair
 * (see lib/format.js) so a process/global aggregate reads distinct from a row. */

import { Box, CellBuffer, Effect } from "yeet:tui";

import { heatFor } from "../lib/format.js";
import { tip, isInspecting } from "../controls.js";

const GLYPH = 0x2580; // "▀" upper half block (a single code point → stored as-is)

/* Default tooltips — the chart's meaning isn't self-evident, so each variant
 * explains itself in the minibuffer on hover. */
const TITLES = {
  conn: "connection traffic — bytes/sec per column; upper half = sent (egress), lower = received (ingress); brighter = more",
  agg: "process total — bytes/sec across all its connections; upper = sent, lower = received; brighter = more",
  global: "all processes — total bytes/sec; upper = sent, lower = received; brighter = more",
};

export default function Sparkline({ hist, now, span, width, variant = "conn", title }) {
  const w = Math.max(1, width | 0);
  const pal = heatFor(variant);
  const cb = CellBuffer({ rows: 1, cols: w });
  /* Writable views into the buffer's planes — captured once; the buffer never
   * reallocates, so these stay valid across redraws. fg/bg take color ints. */
  const chars = cb.chars.window([0]).flat();
  const fg = cb.fg.window([0]).flat();
  const bg = cb.bg.window([0]).flat();

  const draw = () => {
    if (!hist) return;
    /* The runtime composites a CellBuffer above any box behind it, so an opaque
     * panel can't occlude these cells — its empty cells let our ▀ bleed through.
     * The table's bars (conn/agg) sit entirely under the inspector, so blank
     * them to spaces (transparent) while it's open. The global bar lives in the
     * toolbar, above the panel, so it keeps drawing. */
    if (variant !== "global" && isInspecting()) {
      for (let c = 0; c < w; c++) { chars[c] = 0x20; fg[c] = 0; bg[c] = 0; }
      cb.touch();
      return;
    }
    const s = span.get();
    /* Snap the right edge to the column grid (colMs = span/w). Without this the
     * window re-bins every bucket a fraction of a cell each tick, so the bars
     * shimmer and the newest cell grows-then-resets ("inching"). Snapped, the
     * chart holds still between ticks and scrolls exactly one cell when time
     * crosses a column boundary. Only the *view* snaps — recentBytes (window
     * with cols=1, for sort/activeOnly) still reads the true now. */
    const colMs = Math.max(1, s / w);
    const edge = Math.floor(now.get() / colMs) * colMs;
    const { up, down, peak } = hist.window(edge, s, w);
    const p = Math.max(1, peak);
    for (let c = 0; c < w; c++) {
      chars[c] = GLYPH;
      fg[c] = pal.up((up[c] || 0) / p); // egress → top half
      bg[c] = pal.down((down[c] || 0) / p); // ingress → bottom half
    }
    cb.touch();
  };

  return (
    <Box width={w} height={1} overflow="hidden" {...tip(title ?? TITLES[variant])}>
      {cb}
      <Effect>
        {() => {
          /* draw() sets a Signal (cb.touch) — defer it out of this effect's
           * graph evaluation, then repaint on a timer matching the heartbeat. */
          queueMicrotask(draw);
          const t = setInterval(draw, 500);
          return () => clearInterval(t);
        }}
      </Effect>
    </Box>
  );
}
