/* wssnoop/group — one process: a header row (collapse toggle, pid, ws count, an
 * aggregate sparkline in the distinct "agg" palette) above its connection rows.
 * `conns` arrives role-filtered + in stable identity order from the root; the
 * group owns (a) its `ranks` computed — reading sortKey/clock/vizRange — which
 * drives each row's reactive `order`, and (b) the collapse slice + activeOnly
 * filter, expressed as a per-row `visible` thunk so toggling either re-flows
 * without rebuilding rows. The header is order=-1 so it always pins to the top.
 *
 * Selection (header click → controls.selected) is wired for the future zoom
 * arc; it carries no v1 visual yet. */

import { Box, Text, bold, fg, computed } from "yeet:tui";

import Button from "./button.jsx";
import Row from "./row.jsx";
import Sparkline from "./sparkline.jsx";
import { COL } from "./palette.js";
import { LEFT, GAP } from "./columns.js";
import { collapseFor, cycleGroup, sortKey, filters, tip } from "../controls.js";
import { connMetric, recentBytes, rankMap } from "../lib/rank.js";

const glyph = (n) => (n === 0 ? "▸" : n === Infinity ? "▿" : "▾");

export default function Group({ group, conns, now, span, width, order }) {
  const { pid, hist } = group;

  const ranks = computed(() => {
    const key = sortKey.get();
    const n = now.get();
    const s = span.get();
    return rankMap(conns, (c) => c.key, (c) => connMetric(c, key, n, s));
  });

  /* Under activeOnly, a process whose conns are all quiet in the window has
   * nothing to show — collapse the whole group (header included) to 0 so it
   * drops out rather than leaving an empty header bumping the rest down. */
  const shown = () =>
    !filters.get().activeOnly ||
    conns.some((c) => recentBytes(c.hist, now.get(), span.get()) > 0);

  return (
    <Box
      direction="column"
      width="1fr"
      height={() => (shown() ? "fit" : 0)}
      overflow="hidden"
      order={order}
    >
      <Box
        direction="row"
        height={1}
        order={-1}
        {...tip(() => `process ${pid} — ${conns.length} WebSocket connection(s)`)}
      >
        <Box width={LEFT} direction="row" gap={GAP} break="none">
          <Button title={`toggle rows shown for pid ${pid}`} onClick={() => cycleGroup(pid)}>
            {() => glyph(collapseFor(pid))}
          </Button>
          <Text break="none">{bold(fg(COL.accent)(`pid ${pid}`))}</Text>
          <Text break="none">{fg(COL.dim)(`${conns.length} ws`)}</Text>
        </Box>
        <Sparkline hist={hist} now={now} span={span} width={width} variant="agg" />
      </Box>
      {conns.map((c) => (
        <Row
          conn={c}
          now={now}
          span={span}
          width={width}
          order={() => ranks.get().get(c.key) ?? 0}
          visible={() => {
            const r = ranks.get().get(c.key) ?? 1e9;
            if (r >= collapseFor(pid)) return false;
            if (filters.get().activeOnly && recentBytes(c.hist, now.get(), span.get()) <= 0) return false;
            return true;
          }}
        />
      ))}
    </Box>
  );
}
