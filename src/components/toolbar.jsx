/* wssnoop/toolbar — the top chrome. Three stacked strips, all aligned to the
 * shared column geometry:
 *   1. title · status · live counts · the interactive control buttons
 *   2. the GLOBAL activity sparkline (everything, in the distinct "global" tone)
 *   3. the column-header labels (ROLE DEST MSG · ACTIVITY)
 *
 * Every button is mouse-driven and narrates itself into the minibuffer on hover
 * (Button → controls.hoverTitle). Labels are thunks over the control signals, so
 * a click repaints the label in place. */

import { Box, Text, face, computed } from "yeet:tui";

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
  titles, tip,
} from "../controls.js";

export default function Toolbar({ global, stats, status, now, span, sizeSig }) {
  /* The global histogram object is stable (the registry reuses it), but the
   * `global` signal re-sets a fresh wrapper every heartbeat. Dedupe to the
   * stable hist so the global Sparkline node isn't re-minted twice a second —
   * it already reads now/span in its own thunk. */
  const ghist = computed(() => global.get().hist);
  return (
    <Box direction="column" height="fit">
      {/* strip 1 — identity + counts + controls. The wrapper boxes are
          break="none": a text leaf wears its *container's* break (not the
          <Text>'s), so a wrappable wrapper would wrap and bleed into the strips
          below at narrow widths. The row itself clips (overflow="hidden") so a
          too-narrow terminal drops the rightmost controls instead of garbling. */}
      <Box direction="row" height={1} gap={1} overflow="hidden">
        {/* identity + status + counts as ONE run: adjacent auto-width boxes
            don't reliably keep their gap (a box around a dynamic thunk
            under-measures its right edge), so spacing is explicit inside one
            Text instead. */}
        <Box break="none" {...tip("wssnoop — uprobe tap status · open WebSocket connections · messages decoded")}>
          <Text break="none">
            {() => [
              face({ bold: true, fg: COL.title })("wssnoop  "),
              face({ fg: COL.dim })(`${status.get()}   ${stats.get().conns} ws · ${stats.get().msgs} msgs`),
            ]}
          </Text>
        </Box>
        {/* capture-focus indicator: visible only when the kernel filter is
            pinned to one connection; click to release. */}
        <Box
          break="none"
          onClick={clearFocus}
          {...tip("eBPF capture is focused on one connection (others silenced in-kernel) — click to release")}
        >
          <Text break="none">
            {() => {
              const k = focusKey.get();
              if (!k) return "";
              const hex = BigInt(k.slice(k.indexOf(":") + 1)).toString(16);
              const id = hex.length <= 4 ? hex : hex.slice(-4);
              return face({ bg: COL.accent, fg: COL.ink, bold: true })(` ⊙ focused #${id} ✕ `);
            }}
          </Text>
        </Box>
        <Box width="1fr" />
        <Button
          title={titles.search}
          onClick={startSearch}
          active={() => searchActive.get() || !!search.get()}
        >
          {() => (search.get() ? `⌕ ${search.get()}` : "⌕ search")}
        </Button>
        <Button title={titles.sort} onClick={cycleSort}>
          {() => `sort:${SORT_LABELS[sortKey.get()]}`}
        </Button>
        <Button title={titles.role} onClick={cycleRole}>
          {() => `role:${filters.get().role}`}
        </Button>
        <Button title={titles.active} onClick={toggleActive} active={() => filters.get().activeOnly}>
          {() => `idle:${filters.get().activeOnly ? "hidden" : "shown"}`}
        </Button>
        <Button title={titles.rows} onClick={cycleAll}>
          {() => `rows:${COLLAPSE_LABELS[collapse.get().global]}`}
        </Button>
        <Button title={titles.vizDown} onClick={() => cycleViz(-1)}>‹</Button>
        <Text break="none">
          {() => [face({ fg: COL.dim })("win "), face({ fg: COL.accent })(RANGE_LABELS[vizRange.get()])]}
        </Text>
        <Button title={titles.vizUp} onClick={() => cycleViz(1)}>›</Button>
      </Box>

      {/* strip 2 — global aggregate bar */}
      <Box direction="row" height={1} overflow="hidden">
        <Box
          width={LEFT}
          padding={[0, 0, 0, INDENT]}
          break="none"
          overflow="hidden"
          {...tip("ALL — every traced process and connection, combined")}
        >
          <Text break="none" bold fg={COL.accent}>ALL</Text>
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
      <Box direction="row" height={1} overflow="hidden">
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
          <Text break="none" fg={COL.header}>
            {() => `ACTIVITY · last ${RANGE_LABELS[vizRange.get()]} (▀ up / ▄ down)`}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
