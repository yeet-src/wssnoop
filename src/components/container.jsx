/* wssnoop/container — one Docker container: a header row (collapse toggle, ⬢
 * name, process count, an aggregate sparkline summing every member process)
 * above its process groups, each rendered one nesting level deeper (depth=1).
 *
 * It's the optional outer tier of the table: root only wraps processes in a
 * Container when they carry a container id (procinfo derives it from the
 * cgroup); uncontained processes stay at the top level. Collapsing a container
 * hides its processes (each member Group reads the `visible` thunk) without
 * rebuilding them. Like Group, it self-hides under activeOnly when everything
 * inside is quiet, and pins its header to the top with order=-1. */

import { Box, Text, face, computed } from "yeet:tui";

import Button from "./button.jsx";
import Group from "./group.jsx";
import Sparkline from "./sparkline.jsx";
import { COL } from "./palette.js";
import { GAP, HANDLE } from "./columns.js";
import { collapseFor, cycleGroup, COLLAPSE_LABELS, sortKey, filters, tip } from "../controls.js";
import { recentBytes, groupMetric, rankMap } from "../lib/rank.js";

const glyph = (n) => (n === 0 ? "▸" : "▾");

export default function Container({ cid, name, image, members, hist, now, span, geom, order }) {
  const ckey = `c:${cid}`; /* collapse key — distinct from any pid */
  const conns = members.flatMap((m) => m.conns);
  const label = name || cid;

  const headerTip = () =>
    `container ${label}${image ? ` · ${image}` : ""} · ${members.length} process(es), ${conns.length} connection(s)`;

  /* Order the member processes within the container, same metric as the top
   * level uses between groups. */
  const ranks = computed(() => {
    const key = sortKey.get();
    const n = now.get();
    const s = span.get();
    return rankMap(members, (m) => m.g.pid, (m) => groupMetric({ hist: m.g.hist, conns: m.conns }, key, n, s));
  });

  /* Drop the whole container under activeOnly when nothing inside moved. */
  const shown = () =>
    !filters.get().activeOnly ||
    conns.some((c) => recentBytes(c.hist, now.get(), span.get()) > 0);

  return (
    <Box direction="column" width="1fr" height={() => (shown() ? "fit" : 0)} overflow="hidden" order={order}>
      <Box direction="row" height={1} order={-1} {...tip(headerTip)}>
        <Box width={geom.left} direction="row" gap={GAP} break="none">
          <Button
            title={() =>
              `processes in ${label} — now ${COLLAPSE_LABELS[collapseFor(ckey)] ?? "expanded"}; click to ${collapseFor(ckey) === 0 ? "expand" : "collapse"}`
            }
            onClick={() => cycleGroup(ckey)}
          >
            {() => glyph(collapseFor(ckey))}
          </Button>
          <Box width="1fr" overflow="ellipsis">
            <Text break="none">
              {() => [
                face({ bold: true, fg: COL.server })(`⬢ ${label}`),
                image ? face({ fg: COL.dim })(`  ${image}`) : "",
              ]}
            </Text>
          </Box>
          <Text break="none" fg={COL.dim}>{`${members.length} proc`}</Text>
        </Box>
        <Box width={HANDLE} break="none" />
        <Sparkline hist={hist} now={now} span={span} width={geom.spark} variant="agg" />
      </Box>
      {members.map((m) => (
        <Group
          group={m.g}
          conns={m.conns}
          now={now}
          span={span}
          geom={geom}
          depth={1}
          order={() => ranks.get().get(m.g.pid) ?? 0}
          visible={() => collapseFor(ckey) !== 0}
        />
      ))}
    </Box>
  );
}
