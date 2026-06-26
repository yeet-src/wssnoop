/* wssnoop/group — one process: a header row (collapse toggle, pid, ws count, an
 * aggregate sparkline in the distinct "agg" palette) above its connection rows.
 * `conns` arrives role-filtered + in stable identity order from the root; the
 * group owns (a) its `ranks` computed — reading sortKey/clock/vizRange — which
 * drives each row's reactive `order`, and (b) the collapse slice + activeOnly
 * filter, expressed as a per-row `visible` thunk so toggling either re-flows
 * without rebuilding rows. The header is order=-1 so it always pins to the top.
 *
 * The header labels the process by its resolved identity (comm / cmdline, and
 * a container tag when present) rather than a bare pid — see probes/procinfo. */

import { Box, Text, face, computed } from "yeet:tui";

import Button from "./button.jsx";
import Row from "./row.jsx";
import Sparkline from "./sparkline.jsx";
import { COL } from "./palette.js";
import { GAP, HANDLE } from "./columns.js";
import {
  collapseFor, cycleGroup, COLLAPSE_STEPS, COLLAPSE_LABELS,
  sortKey, filters, tip,
} from "../controls.js";
import { connMetric, recentBytes, rankMap } from "../lib/rank.js";
import { procInfo, resolve } from "../probes/procinfo.js";

const glyph = (n) => (n === 0 ? "▸" : n === Infinity ? "▿" : "▾");
const nextCollapse = (n) => COLLAPSE_STEPS[(COLLAPSE_STEPS.indexOf(n) + 1) % COLLAPSE_STEPS.length];

export default function Group({ group, conns, now, span, geom, order }) {
  const { pid, hist } = group;
  resolve(pid); /* fire-and-forget identity lookup; cached, published reactively */

  const headerTip = () => {
    const id = procInfo.get()[pid];
    const cmd = id?.cmdline?.length ? id.cmdline.join(" ") : id?.exe || "";
    const ctr = id?.container ? ` · container ${id.container}` : "";
    const state =
      id && id.alive === false
        ? " · STOPPED (process exited; its rows linger until the connections idle out)"
        : "";
    return `process ${pid}${cmd ? ` · ${cmd}` : ""}${ctr}${state} · ${conns.length} WebSocket connection(s)`;
  };

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
        {...tip(headerTip)}
      >
        <Box width={geom.left} direction="row" gap={GAP} break="none">
          {/* Stateful toggle: the glyph shows the current rows mode, and its
              tooltip names that mode and what the next click does. */}
          <Button
            title={() => {
              const cur = collapseFor(pid);
              const lbl = procInfo.get()[pid]?.label ?? `pid ${pid}`;
              return `rows for ${lbl} · now ${COLLAPSE_LABELS[cur]}; click for ${COLLAPSE_LABELS[nextCollapse(cur)]}`;
            }}
            onClick={() => cycleGroup(pid)}
          >
            {() => glyph(collapseFor(pid))}
          </Button>
          <Box width="1fr" overflow="ellipsis">
            <Text break="none">
              {() => {
                const id = procInfo.get()[pid];
                /* A stopped process reads colorless (grey, no accent); the
                 * mouseover spells out that it exited. */
                const stopped = id && id.alive === false;
                const out = [
                  face(stopped ? { fg: COL.unknown } : { bold: true, fg: COL.accent })(id?.label ?? `pid ${pid}`),
                  face({ fg: COL.dim })(`  pid ${pid}`),
                ];
                if (id?.container)
                  out.push(face({ fg: stopped ? COL.unknown : COL.server })(`  ⬢${id.container}`));
                return out;
              }}
            </Text>
          </Box>
          <Text break="none" fg={COL.dim}>{`${conns.length} ws`}</Text>
        </Box>
        <Box width={HANDLE} break="none" />
        <Sparkline hist={hist} now={now} span={span} width={geom.spark} variant="agg" />
      </Box>
      {conns.map((c) => (
        <Row
          conn={c}
          now={now}
          span={span}
          geom={geom}
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
