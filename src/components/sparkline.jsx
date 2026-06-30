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

import { Box, CellBuffer, Effect, rgb } from "yeet:tui";

import { heatFor, fmtBytes, fmtAgo } from "../lib/format.js";
import {
  isInspecting,
  cursorFrac, cursorPinned, moveCursor, leaveCursor, toggleCursorPin,
} from "../controls.js";

const GLYPH = 0x2580; // "▀" upper half block (a single code point → stored as-is)
const CURSOR = rgb(0xfdf6e3); // crosshair line — bright ink, reads over any heat
const CURSOR_BG = rgb(0x30363d); // its lit cell, a touch above the track

/* Default tooltips — the chart's meaning isn't self-evident, so each variant
 * explains itself in the minibuffer on hover. */
const TITLES = {
  conn: "connection traffic · bytes/sec per column; upper half = sent (egress), lower = received (ingress); brighter = more",
  agg: "process total · bytes/sec across all its connections; upper = sent, lower = received; brighter = more",
  global: "all processes · total bytes/sec; upper = sent, lower = received; brighter = more",
};

/* The window the bar currently shows, snapped to its column grid (same snap the
 * draw uses) so a frac/column maps to a stable instant. Returns the per-column
 * up/down series plus colMs and the right-edge time. */
const windowAt = (hist, now, span, w) => {
  const s = span.get();
  const colMs = Math.max(1, s / w);
  const edge = Math.floor(now.get() / colMs) * colMs;
  return { ...hist.window(edge, s, w), colMs, edge };
};

/* Column under a 0..1 cursor fraction. */
const colAt = (frac, w) => Math.min(w - 1, Math.max(0, Math.round(frac * (w - 1))));

export default function Sparkline({ hist, now, span, width, originX = 0, variant = "conn", title }) {
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
    /* The shared crosshair: every bar shows the same window column-aligned, so a
     * single frac lands at the same instant in all of them — a vertical line
     * down the screen. A full-height bar (█) in bright ink reads over any heat. */
    const f = cursorFrac.get();
    if (f != null) {
      const c = colAt(f, w);
      chars[c] = 0x2588; // "█" full block → a solid vertical segment
      fg[c] = CURSOR;
      bg[c] = CURSOR_BG;
    }
    cb.touch();
  };

  /* The hover readout: while a cursor is set, name the instant under it and this
   * bar's bytes there; otherwise the variant's static explanation. */
  const readout = () => {
    const f = cursorFrac.get();
    if (f == null || !hist) return title ?? TITLES[variant];
    const { up, down, colMs, edge } = windowAt(hist, now, span, w);
    const c = colAt(f, w);
    const age = edge - (w - 1 - c) * colMs;
    const when = now.get() - age < colMs ? "now" : `${fmtAgo(now.get() - age)} ago`;
    const per = Math.max(1, Math.round(colMs / 1000));
    const pin = cursorPinned.get() ? " · pinned" : "";
    return `${when} · ↑${fmtBytes(up[c] || 0)} ↓${fmtBytes(down[c] || 0)} per ${per}s · click to focus this moment${pin}`;
  };

  const fracOf = (e) => (w > 1 ? (e.clientX - originX) / (w - 1) : 0);

  return (
    <Box
      width={w}
      height={1}
      overflow="hidden"
      onMouseEnter={() => moveCursor(cursorFrac.get() ?? 1, readout)}
      onMouseLeave={leaveCursor}
      onMouseMove={(e) => moveCursor(fracOf(e), readout)}
      onClick={(e) => {
        toggleCursorPin(fracOf(e));
        e.stopPropagation?.(); // a bar click focuses the moment, it doesn't open the row
      }}
    >
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
      {/* Repaint promptly when the shared cursor moves (not just on the 500ms
          heartbeat) so the crosshair tracks the pointer across every bar. */}
      <Effect>
        {() => {
          cursorFrac.get(); // dependency: re-run on cursor change
          queueMicrotask(draw);
        }}
      </Effect>
    </Box>
  );
}
