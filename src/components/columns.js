/* columns — the one source of truth for the grouped table's horizontal
 * geometry. Every row kind (the global bar, a process header, a connection
 * row, the column-header strip) reserves the SAME left region and starts its
 * sparkline at the SAME column, so the bars line up vertically down the screen.
 *
 *   [ role | dest | msg↑/↓ ]│ ▀▀▀▀▀▀▀▀ activity ▀▀▀▀▀▀▀▀
 *   └────────  left  ──────┘╵  └──────  spark  ─────┘
 *                          handle (drag to resize)
 *
 * The left region's width is dominated by DEST (the wss:// URL — the column
 * that matters most), so it *flexes*: the sparkline is capped and DEST takes
 * the rest, and a drag on the header handle pins an explicit DEST width. All of
 * it is derived by `layout(cols, destW)` — the single size-dependent function,
 * computed once per frame and threaded down so every strip shares one geometry.
 */

export const INDENT = 2; /* connection rows nest under their process header */
export const W_ROLE = 7; /* client / server / ?           */
export const W_MSG = 13; /* "120↑ 98↓"                    */
export const GAP = 1; /* between the left cells        */
export const HANDLE = 1; /* the drag handle / separator between left and spark */

/* Bounds. DEST never collapses below readability; the sparkline is capped so a
 * wide terminal pours its extra width into the URL, not the bars. */
export const DEST_MIN = 18;
const SPARK_MIN = 12;
const SPARK_MAX = 44;
const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));

/* Everything but the dest/spark split: the fixed cells those two share the
 * leftover width around (INDENT + role + gaps + msg + handle). */
const FIXED = INDENT + W_ROLE + GAP + GAP + W_MSG + HANDLE;

/* The column the drag handle sits at is the left region's width; the handle
 * butts against the right edge of MSG, so `dest = clientX - START`. */
export const START = INDENT + W_ROLE + GAP + GAP + W_MSG;

/* Resolve the width-dependent geometry. `destW == null` is auto: cap the
 * sparkline, give DEST the rest. A number pins DEST (a header drag), clamped so
 * neither column starves. Returns { dest, spark, left } — every strip's widths. */
export function layout(cols, destW = null) {
  const avail = Math.max(SPARK_MIN + DEST_MIN, cols - FIXED - 1); // dest + spark
  let dest, spark;
  if (destW == null) {
    spark = clamp(SPARK_MIN, SPARK_MAX, Math.round(avail * 0.4));
    dest = clamp(DEST_MIN, avail - SPARK_MIN, avail - spark);
  } else {
    dest = clamp(DEST_MIN, avail - SPARK_MIN, destW);
    spark = Math.max(SPARK_MIN, avail - dest);
  }
  const left = INDENT + W_ROLE + GAP + dest + GAP + W_MSG;
  return { dest, spark, left };
}
