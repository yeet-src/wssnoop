/* wssnoop/controls — UI state, separate from data state (state.js).
 *
 * These are the *view* concerns — what's shown and how it's ordered — held as
 * plain signals plus the actions that cycle them. The data layer (state.js)
 * never reads these; the components read both and apply controls to the raw
 * groups at render time (filter -> sort -> slice). Keeping them here means the
 * toolbar buttons and the layout share one source of truth, and a control
 * change repaints without touching the BPF tap.
 *
 * Mouse-driven UI convention: every Button writes its tooltip to `hoverTitle`
 * on pointer-enter and clears it on leave; the minibuffer renders it. The title
 * is global state precisely so the Button doesn't need to know the minibuffer.
 */

import { signal } from "yeet:tui";

const wrap = (arr, v, dir = 1) => {
  const i = arr.indexOf(v);
  return arr[(i + dir + arr.length) % arr.length];
};

/* ---- visualization range (the sparkline time span) ------------------- */
/* Distinct from retention (state.js evicts idle conns at the max range). */
export const RANGES = [60_000, 300_000, 900_000, 1_800_000]; // 1m / 5m / 15m / 30m (ms)
export const RANGE_LABELS = { 60_000: "1m", 300_000: "5m", 900_000: "15m", 1_800_000: "30m" };
export const vizRange = signal(300_000); // default 5m
export const cycleViz = (dir = 1) => vizRange.update((v) => wrap(RANGES, v, dir));

/* ---- sort (applied to connection rows *and* to group order) ---------- */
/* recent = bytes within the current viz window; newest = startedAt desc;
 * bytes  = lifetime totalUp+totalDown desc. */
export const SORTS = ["recent", "newest", "bytes"];
export const SORT_LABELS = { recent: "recent", newest: "newest", bytes: "bytes" };
export const sortKey = signal("recent");
export const cycleSort = () => sortKey.update((s) => wrap(SORTS, s));

/* ---- filters --------------------------------------------------------- */
/* role: all | client | server.  activeOnly: hide conns idle in the window.
 * (ws-only is enforced upstream in state.js — non-WS never enters a group.) */
export const filters = signal({ role: "all", activeOnly: false });
export const ROLES = ["all", "client", "server"];
export const cycleRole = () => filters.update((f) => ({ ...f, role: wrap(ROLES, f.role) }));
export const toggleActive = () => filters.update((f) => ({ ...f, activeOnly: !f.activeOnly }));

/* ---- search (free-text) ---------------------------------------------- */
/* One query box, context-sensitive: it filters the message log while the
 * inspector is open, and the connection table otherwise. `active` is whether
 * we're capturing keystrokes into it (main.jsx routes keydowns); the query
 * persists as a live filter after you stop typing (Enter), and clears on Esc.
 * `matches(text)` is the shared case-insensitive test. */
export const search = signal("");
export const searchActive = signal(false);
export const startSearch = () => searchActive.set(true);
export const stopSearch = () => searchActive.set(false); // confirm: keep the query
export const clearSearch = () => {
  search.set("");
  searchActive.set(false);
};
export const typeSearch = (ch) => search.update((s) => s + ch);
export const backspaceSearch = () => search.update((s) => s.slice(0, -1));
export const matches = (text, q = search.get()) =>
  !q || (text != null && String(text).toLowerCase().includes(q.toLowerCase()));

/* ---- collapse (rows shown per process group) ------------------------- */
/* n connections to show: 0 = collapsed (header only), 12 = default,
 * Infinity = expanded (all rows). A global default plus per-pid overrides:
 * `cycleAll` advances the default and drops overrides (re-syncs everything);
 * `cycleGroup` advances just one pid. `collapseFor` resolves the effective n. */
export const COLLAPSE_STEPS = [0, 12, Infinity];
export const COLLAPSE_LABELS = { 0: "collapsed", 12: "12 rows", [Infinity]: "all rows" };
export const collapse = signal({ global: 12, overrides: {} });
export const collapseFor = (pid) => {
  const c = collapse.get();
  return pid in c.overrides ? c.overrides[pid] : c.global;
};
export const cycleAll = () =>
  collapse.update((c) => ({ global: wrap(COLLAPSE_STEPS, c.global), overrides: {} }));
export const cycleGroup = (pid) =>
  collapse.update((c) => {
    const cur = pid in c.overrides ? c.overrides[pid] : c.global;
    return { ...c, overrides: { ...c.overrides, [pid]: wrap(COLLAPSE_STEPS, cur) } };
  });

/* ---- selection (the inspector drill-down) ---------------------------- */
/* `selected` is the connection key (`${pid}:${ssl}`) being inspected, or null
 * when the overlay is closed. Clicking a row opens it; the scrim, the close
 * button, and Escape clear it. The inspector resolves the key against the live
 * registry each frame, so an evicted/closed connection is detectable. */
export const selected = signal(null);

/* Inspector view-state. Module-level (not local to the Inspector component) on
 * purpose: the root body re-projects on every clock tick, which re-creates the
 * Inspector node each heartbeat — local signals would reset twice a second.
 * Living here, they persist across those rebuilds. `inspect` resets them so a
 * freshly opened connection starts live, unscrolled, collapsed. */
export const inspectScroll = signal(0); // index of the topmost shown message
export const inspectExpanded = signal(null); // seq of the message whose payload is open
export const inspectFrozen = signal(false); // paused (reading history) vs. following live
export const inspectSnap = signal([]); // frozen snapshot of messages while paused

export const inspect = (key) => {
  selected.set(key);
  inspectFrozen.set(false);
  inspectScroll.set(0);
  inspectExpanded.set(null);
  inspectSnap.set([]);
  clearSearch(); /* the query is context-scoped (messages vs connections) */
};
export const closeInspector = () => {
  selected.set(null);
  clearSearch();
};
export const isInspecting = () => selected.get() != null;

export const hoverTitle = signal(""); // current tooltip, shown in the minibuffer

/* Transient status line (e.g. "copied 42 messages"). Shown in the minibuffer
 * over the hover tooltip for a moment, then clears itself. A token guards
 * against an older flash clearing a newer one. */
export const toast = signal("");
let toastN = 0;
export function flash(msg, ms = 2500) {
  toast.set(msg);
  const n = ++toastN;
  setTimeout(() => {
    if (n === toastN) toast.set("");
  }, ms);
}

/* Spreadable hover-tooltip handlers for ANY Box (not just Button): `<Box
 * {...tip("…")}>`. `t` may be a string or a thunk (use a thunk when the text
 * depends on live values, e.g. a connection's current counts). */
export const tip = (t) => ({
  onMouseEnter: () => hoverTitle.set(typeof t === "function" ? t() : t),
  onMouseLeave: () => hoverTitle.set(""),
});
