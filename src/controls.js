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
/* Editing the query jumps the inspector log back to the top — the filtered set
 * shrinks, so a stale scroll offset would otherwise sit past its end. */
export const typeSearch = (ch) => (search.update((s) => s + ch), inspectScroll.set(0));
export const backspaceSearch = () => (search.update((s) => s.slice(0, -1)), inspectScroll.set(0));
export const matches = (text, q = search.get()) =>
  !q || (text != null && String(text).toLowerCase().includes(q.toLowerCase()));

/* ---- collapse (rows shown per process group) ------------------------- */
/* n connections to show: 0 = collapsed (header only), 12 = default,
 * Infinity = expanded (all rows). A global default plus per-pid overrides:
 * `cycleAll` advances the default and drops overrides (re-syncs everything);
 * `cycleGroup` advances just one pid. `collapseFor` resolves the effective n. */
export const COLLAPSE_STEPS = [0, 12, Infinity];
export const COLLAPSE_LABELS = { 0: "collapsed", 12: "max 12", [Infinity]: "all" };
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
 * when the overlay is closed. `selectedConn` holds the actual conn object, so
 * the inspector can guard against SSL* reuse: OpenSSL recycles freed pointers,
 * so a new connection can appear under the *same key* — identity (not key)
 * tells "still the connection I opened" from "a different one reusing the
 * pointer". Clicking a row opens it; the scrim / close button / Escape clear it. */
export const selected = signal(null);
export const selectedConn = signal(null);

/* Inspector view-state. Module-level (not local to the Inspector component) on
 * purpose: the root body re-projects on every clock tick, which re-creates the
 * Inspector node each heartbeat — local signals would reset twice a second.
 * Living here, they persist across those rebuilds. `inspect` resets them so a
 * freshly opened connection starts live, unscrolled, collapsed. */
export const inspectScroll = signal(0); // index of the topmost shown message
export const inspectExpanded = signal(null); // seq of the message whose payload is open
export const inspectFrozen = signal(false); // paused (reading history) vs. following live
export const inspectSnap = signal([]); // frozen snapshot of messages while paused
export const inspectDetails = signal(false); // connection metadata expanded (hidden by default)
export const inspectRaw = signal(false); // show an expanded payload as raw hex vs decoded
export const toggleDetails = () => inspectDetails.update((v) => !v);
export const toggleRaw = () => inspectRaw.update((v) => !v);

export const inspect = (conn) => {
  selected.set(conn.key);
  selectedConn.set(conn);
  inspectFrozen.set(false);
  inspectScroll.set(0);
  inspectExpanded.set(null);
  inspectSnap.set([]);
  inspectDetails.set(false);
  inspectRaw.set(false);
  clearSearch(); /* the query is context-scoped (messages vs connections) */
};
export const closeInspector = () => {
  selected.set(null);
  selectedConn.set(null);
  clearSearch();
};
export const isInspecting = () => selected.get() != null;

/* ---- kernel capture focus (user → kernel write) ---------------------- */
/* The connection key the BPF filter is pinned to, or null for "capture all".
 * state.js watches this and patches the probe's .bss globals, so focusing a
 * connection silences every other one IN THE KERNEL — targeted, near-zero
 * overhead capture. A UI control, but it really does reach down into eBPF. */
export const focusKey = signal(null);
export const setFocus = (key) => {
  focusKey.set(key);
  flash("eBPF capture pinned to this connection — every other one is now silenced in the kernel");
};
export const clearFocus = () => {
  focusKey.set(null);
  flash("capture focus released — all connections live again");
};
export const isFocused = (key) => focusKey.get() === key;

/* ---- global keymap + self-describing tooltips ------------------------ */
/* One source of truth for the toolbar's global-action buttons AND the
 * command-mode keys (main.jsx dispatches `keymap`). Each `titles.*` is a thunk
 * that names the CURRENT state and the key that changes it — so the mouseover
 * both reflects state and teaches the shortcut. Stored unresolved in
 * `hoverTitle` (see `tip`), the minibuffer re-evaluates it every frame, so a
 * tooltip stays live as its control cycles under the pointer. */
const next = (arr, v) => arr[(arr.indexOf(v) + 1) % arr.length];

export const titles = {
  search: () =>
    searchActive.get() || search.get()
      ? `search (/) — filtering “${search.get()}”; Esc clears`
      : "search (/) — filter messages while inspecting, connections otherwise",
  sort: () => `sort (s) — now ${SORT_LABELS[sortKey.get()]}; press s for ${SORT_LABELS[next(SORTS, sortKey.get())]}`,
  role: () => `role (r) — now ${filters.get().role}; press r for ${next(ROLES, filters.get().role)}`,
  active: () =>
    `idle rows (i) — now ${filters.get().activeOnly ? "hidden" : "shown"}; press i to ${filters.get().activeOnly ? "show" : "hide"} them`,
  rows: () =>
    `rows per process (a) — now ${COLLAPSE_LABELS[collapse.get().global]}; press a for ${COLLAPSE_LABELS[next(COLLAPSE_STEPS, collapse.get().global)]}`,
  vizDown: () => `shorter activity window ([) — now ${RANGE_LABELS[vizRange.get()]}`,
  vizUp: () => `longer activity window (]) — now ${RANGE_LABELS[vizRange.get()]}`,
};

/* command-mode key → action. `/`, `q`, and Esc are handled in main.jsx (they
 * route search / quit / back-out and so aren't plain cycles). */
export const keymap = {
  s: cycleSort,
  r: cycleRole,
  i: toggleActive,
  a: cycleAll,
  "[": () => cycleViz(-1),
  "]": () => cycleViz(1),
};

/* ---- column resize (drag the DEST / activity boundary) --------------- */
/* `destWidth` is the DEST column width in cells, or null for auto (the
 * sparkline-capped default in columns.layout). Dragging the header handle pins
 * an explicit width; `dragging` mounts a full-screen overlay (root) that tracks
 * the move so the pointer needn't stay on the 1-cell handle. The pointer-x →
 * cells conversion lives with the geometry (columns.js / toolbar); this layer
 * just holds the state. Double-click the handle to release back to auto. */
export const destWidth = signal(null);
export const dragging = signal(false);
export const startColDrag = () => dragging.set(true);
export const endColDrag = () => dragging.set(false);
export const resetColWidth = () => destWidth.set(null);

export const hoverTitle = signal(""); // current tooltip (string | thunk), resolved in the minibuffer

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
 * {...tip("…")}>`. `t` may be a string or a thunk; we stash it *unresolved* so
 * the minibuffer re-evaluates it each frame — a thunk over live values (a
 * connection's counts, a control's current state) then stays current while the
 * pointer rests on it. */
export const tip = (t) => ({
  onMouseEnter: () => hoverTitle.set(t),
  onMouseLeave: () => hoverTitle.set(""),
});
