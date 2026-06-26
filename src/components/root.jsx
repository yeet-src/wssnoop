/* wssnoop/root — the app shell and the one place raw data meets the view
 * controls. state.js republishes `groups` only on membership change; this body
 * thunk therefore rebuilds row *structure* only when the set of conns changes
 * (or on resize / a role-filter toggle). Ordering is reactive-but-structureless:
 * a `groupRank` computed (reading sortKey/clock/vizRange) drives each group's
 * `order` prop, so re-ranking — including the per-tick churn of the "recent"
 * key — re-flows the layout order without rebuilding anything.
 *
 *   toolbar (global bar + headers)  ·  grouped table (1fr)  ·  minibuffer
 */

import { Box, Text, Layer, computed } from "yeet:tui";

import Toolbar from "./toolbar.jsx";
import Group from "./group.jsx";
import Container from "./container.jsx";
import Inspector from "./inspector.jsx";
import Minibuffer from "./minibuffer.jsx";
import SearchBar from "./searchbar.jsx";
import { COL } from "./palette.js";
import { layout, START, DEST_MIN } from "./columns.js";
import {
  vizRange, sortKey, filters, selected, search, matches, isInspecting,
  destWidth, dragging, endColDrag,
} from "../controls.js";
import { groupMetric, rankMap } from "../lib/rank.js";
import { mergeHists } from "../lib/timehist.js";
import { procInfo } from "../probes/procinfo.js";
import { containers } from "../probes/containers.js";

export default function Root({ size, groups, global, stats, status, clock }) {
  return (
    <Box direction="column" width="1fr" height="1fr" bg={COL.bg}>
      <Toolbar global={global} stats={stats} status={status} now={clock} span={vizRange} sizeSig={size} />
      <Box height="1fr" overflow="hidden">
       <Layer>
        <Box width="1fr" height="1fr" overflow="hidden">
        {() => {
          /* Membership level: role is fixed once a conn handshakes, so the role
           * filter and the empty-group drop belong here (rebuild on toggle, not
           * per tick). activeOnly is time-varying, so it's applied per-row in
           * the group instead. */
          const role = filters.get().role;
          /* Reading destWidth here (not just cols) means a header drag re-flows
           * the table — the sparkline's CellBuffer is sized at build time, so a
           * width change has to rebuild the row, same as a resize does. */
          const geom = layout(size.get().cols, destWidth.get());
          /* Free-text targets messages while the inspector is open, so it only
           * narrows the table when the inspector is closed. */
          const q = isInspecting() ? "" : search.get();
          const info = procInfo.get();
          let view = groups
            .get()
            .map((g) => ({ g, conns: role === "all" ? g.conns : g.conns.filter((c) => c.role === role) }))
            .filter(({ conns }) => conns.length > 0);

          if (q) {
            view = view
              .map(({ g, conns }) =>
                matches(info[g.pid]?.label ?? "", q) // whole process matches → keep all its conns
                  ? { g, conns }
                  : { g, conns: conns.filter((c) => matches(`${c.role} ${c.dest}`, q)) },
              )
              .filter(({ conns }) => conns.length > 0);
          }

          if (view.length === 0) {
            if (q) return <Text break="none" italic fg={COL.dim}>{`  no connections match “${q}”`}</Text>;
            /* No WebSocket connections yet. The toolbar status line already
             * shows the probe state (tracing / probe failed), so keep this quiet. */
            return <Text break="none" italic fg={COL.dim}>  No WSS connections</Text>;
          }

          /* Optional outer tier: partition processes by their container id
           * (procinfo derives it from the cgroup; null = not containerized).
           * Each container becomes one top-level node wrapping its processes;
           * uncontained processes stay at the top level beside them. */
          const cmap = containers.get(); // shortId -> { name, image } (empty without Docker)
          const byCtr = new Map();
          for (const e of view) {
            const cid = info[e.g.pid]?.container ?? null;
            let arr = byCtr.get(cid);
            if (!arr) byCtr.set(cid, (arr = []));
            arr.push(e);
          }
          const nodes = [];
          for (const [cid, members] of byCtr) {
            if (cid === null)
              for (const m of members)
                nodes.push({ kind: "group", key: `g:${m.g.pid}`, g: m.g, conns: m.conns, hist: m.g.hist });
            else
              nodes.push({
                kind: "container",
                key: `c:${cid}`,
                cid,
                meta: cmap[cid] ?? null,
                members,
                hist: mergeHists(members.map((m) => m.g.hist)),
                conns: members.flatMap((m) => m.conns),
              });
          }

          /* One rank map over the top-level nodes (containers + bare groups),
           * by the same metric — a container ranks by its merged activity. */
          const topRank = computed(() => {
            const key = sortKey.get();
            const now = clock.get();
            const span = vizRange.get();
            return rankMap(nodes, (n) => n.key, (n) => groupMetric(n, key, now, span));
          });

          return nodes.map((n) =>
            n.kind === "group" ? (
              <Group
                group={n.g}
                conns={n.conns}
                now={clock}
                span={vizRange}
                geom={geom}
                order={() => topRank.get().get(n.key) ?? 0}
              />
            ) : (
              <Container
                cid={n.cid}
                name={n.meta?.name}
                image={n.meta?.image}
                members={n.members}
                hist={n.hist}
                now={clock}
                span={vizRange}
                geom={geom}
                order={() => topRank.get().get(n.key) ?? 0}
              />
            ),
          );
        }}
        </Box>
        {() => (selected.get() != null ? <Inspector groups={groups} now={clock} size={size} /> : null)}
        {/* While dragging the column handle, a transparent full-screen lid
            tracks the pointer anywhere on screen (it needn't stay on the 1-cell
            handle) and ends the drag on release. */}
        {() =>
          dragging.get() ? (
            <Box
              width="1fr"
              height="1fr"
              z={2}
              onMouseMove={(e) => destWidth.set(Math.max(DEST_MIN, e.clientX - START))}
              onMouseUp={endColDrag}
              onMouseLeave={endColDrag}
            />
          ) : null
        }
       </Layer>
      </Box>
      <SearchBar />
      <Minibuffer />
    </Box>
  );
}
