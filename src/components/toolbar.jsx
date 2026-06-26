/* wssnoop/toolbar — the top chrome. Three stacked strips, all aligned to the
 * shared column geometry:
 *   1. title · status · live counts · the interactive control buttons
 *   2. the GLOBAL activity sparkline (everything, in the distinct "global" tone)
 *   3. the column-header labels (ROLE DEST MSG · ACTIVITY)
 *
 * Every button is mouse-driven and narrates itself into the minibuffer on hover
 * (Button → controls.hoverTitle). Labels are thunks over the control signals, so
 * a click repaints the label in place. */

import { Box, Text, bold, fg, bg, computed } from "yeet:tui";

import Button from "./button.jsx";
import Sparkline from "./sparkline.jsx";
import { COL } from "./palette.js";
import { INDENT, W_ROLE, W_DEST, W_MSG, GAP, LEFT, sparkWidth } from "./columns.js";
import {
  vizRange, RANGE_LABELS, cycleViz,
  sortKey, SORT_LABELS, cycleSort,
  filters, cycleRole, toggleActive,
  collapse, COLLAPSE_LABELS, cycleAll,
  search, searchActive, startSearch,
  focusKey, clearFocus,
  tip,
} from "../controls.js";

export default function Toolbar({ global, stats, status, now, span, sizeSig }) {
  /* The global histogram object is stable (the registry reuses it), but the
   * `global` signal re-sets a fresh wrapper every heartbeat. Dedupe to the
   * stable hist so the global Sparkline node isn't re-minted twice a second —
   * it already reads now/span in its own thunk. */
  const ghist = computed(() => global.get().hist);
  return (
    <Box direction="column" height="fit">
      {/* strip 1 — identity + counts + controls */}
      <Box direction="row" height={1} gap={1}>
        <Text break="none">{bold(fg(COL.title)("wssnoop"))}</Text>
        <Box {...tip("tap status — the SSL_read/SSL_write uprobe state")}>
          <Text break="none">{() => fg(COL.dim)(status.get())}</Text>
        </Box>
        <Box {...tip("live totals — open WebSocket connections · messages decoded")}>
          <Text break="none">
            {() => fg(COL.dim)(`${stats.get().conns} ws · ${stats.get().msgs} msgs`)}
          </Text>
        </Box>
        {/* capture-focus indicator: visible only when the kernel filter is
            pinned to one connection; click to release. */}
        <Box
          onClick={clearFocus}
          {...tip("eBPF capture is focused on one connection (others silenced in-kernel) — click to release")}
        >
          <Text break="none">
            {() => (focusKey.get() ? bg(COL.accent)(fg(COL.ink)(bold(" ⊙ focused ✕ "))) : "")}
          </Text>
        </Box>
        <Box width="1fr" />
        <Button
          title="search (/) — filters messages while inspecting, connections otherwise"
          onClick={startSearch}
          active={() => searchActive.get() || !!search.get()}
        >
          {() => (search.get() ? `⌕ ${search.get()}` : "⌕ search")}
        </Button>
        <Button title="sort connections and groups" onClick={cycleSort}>
          {() => `sort:${SORT_LABELS[sortKey.get()]}`}
        </Button>
        <Button title="filter by role (all / client / server)" onClick={cycleRole}>
          {() => `role:${filters.get().role}`}
        </Button>
        <Button
          title="show all connections, or only those with traffic in the window"
          onClick={toggleActive}
          active={() => filters.get().activeOnly}
        >
          {() => `idle:${filters.get().activeOnly ? "hidden" : "shown"}`}
        </Button>
        <Button title="rows shown per process: collapsed / max 12 / all" onClick={cycleAll}>
          {() => `rows:${COLLAPSE_LABELS[collapse.get().global]}`}
        </Button>
        <Button title="shorter activity window" onClick={() => cycleViz(-1)}>‹</Button>
        <Text break="none">{() => [fg(COL.dim)("win "), fg(COL.accent)(RANGE_LABELS[vizRange.get()])]}</Text>
        <Button title="longer activity window" onClick={() => cycleViz(1)}>›</Button>
      </Box>

      {/* strip 2 — global aggregate bar */}
      <Box direction="row" height={1}>
        <Box
          width={LEFT}
          padding={[0, 0, 0, INDENT]}
          break="none"
          {...tip("ALL — every traced process and connection, combined")}
        >
          <Text break="none">{bold(fg(COL.accent)("ALL"))}</Text>
        </Box>
        {() => (
          <Sparkline
            hist={ghist.get()}
            now={now}
            span={span}
            width={sparkWidth(sizeSig.get().cols)}
            variant="global"
          />
        )}
      </Box>

      {/* strip 3 — column headers */}
      <Box direction="row" height={1}>
        <Box width={LEFT} direction="row" gap={GAP} padding={[0, 0, 0, INDENT]} break="none">
          <Box width={W_ROLE} {...tip("ROLE — client (we opened it) or server (we serve it)")}>
            <Text fg={COL.header} break="none">ROLE</Text>
          </Box>
          <Box width={W_DEST} {...tip("DEST — destination wss:// URL for client connections; '?' for served ones")}>
            <Text fg={COL.header} break="none">DEST</Text>
          </Box>
          <Box width={W_MSG} {...tip("MSG — WebSocket messages sent (↑) and received (↓)")}>
            <Text fg={COL.header} break="none">MSG ↑/↓</Text>
          </Box>
        </Box>
        <Box {...tip("ACTIVITY — bytes/sec over the window; upper half = sent, lower = received; brighter = more")}>
          <Text break="none">{() => fg(COL.header)(`ACTIVITY · last ${RANGE_LABELS[vizRange.get()]} (▀ up / ▄ down)`)}</Text>
        </Box>
      </Box>
    </Box>
  );
}
