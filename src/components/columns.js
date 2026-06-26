/* columns — the one source of truth for the grouped table's horizontal
 * geometry. Every row kind (the global bar, a process header, a connection
 * row, the column-header strip) reserves the SAME left region and starts its
 * sparkline at the SAME column, so the bars line up vertically down the screen.
 *
 * The left region is one fixed-width Box (`LEFT` cells); the sparkline takes
 * the rest. `sparkWidth(cols)` is the only size-dependent number, computed once
 * from the terminal width and threaded down so all bars share a column count.
 *
 *   [ role | dest | msg↑/↓ ]  ┊  ▀▀▀▀▀▀▀▀ activity ▀▀▀▀▀▀▀▀
 *   └────────  LEFT  ───────┘     └──────  sparkWidth  ─────┘
 */

export const INDENT = 2; /* connection rows nest under their process header */
export const W_ROLE = 7; /* client / server / ?           */
export const W_DEST = 34; /* wss://host/path (ellipsis)    */
export const W_MSG = 13; /* "120↑ 98↓"                    */
export const GAP = 1; /* between the left cells        */

/* INDENT + role + GAP + dest + GAP + msg  (= the fixed left region). */
export const LEFT = INDENT + W_ROLE + GAP + W_DEST + GAP + W_MSG; // 58

/* Columns the sparkline gets after the left region — clamped so it never
 * collapses on a narrow terminal. */
export const sparkWidth = (cols) => Math.max(8, cols - LEFT - 1);
