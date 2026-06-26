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
import Inspector from "./inspector.jsx";
import Minibuffer from "./minibuffer.jsx";
import SearchBar from "./searchbar.jsx";
import { COL } from "./palette.js";
import { sparkWidth } from "./columns.js";
import { vizRange, sortKey, filters, selected, search, matches, isInspecting } from "../controls.js";
import { groupMetric, rankMap } from "../lib/rank.js";
import { procInfo } from "../probes/procinfo.js";

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
          const width = sparkWidth(size.get().cols);
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
            if (q) return <Text break="none" fg={COL.dim}>{`  no connections match “${q}”`}</Text>;
            /* Reassure during the opening dead air: the tap is live, just no
             * handshake yet. Show the probe status so a failed attach is plain. */
            return (
              <Text break="anywhere" fg={COL.dim}>
                {() => `  ${status.get()} — waiting for the first WebSocket handshake…  (try ./demo/run.sh --attach)`}
              </Text>
            );
          }

          const groupRank = computed(() => {
            const key = sortKey.get();
            const now = clock.get();
            const span = vizRange.get();
            return rankMap(view.map((v) => v.g), (g) => g.pid, (g) => groupMetric(g, key, now, span));
          });

          return view.map(({ g, conns }) => (
            <Group
              group={g}
              conns={conns}
              now={clock}
              span={vizRange}
              width={width}
              order={() => groupRank.get().get(g.pid) ?? 0}
            />
          ));
        }}
        </Box>
        {() => (selected.get() != null ? <Inspector groups={groups} now={clock} size={size} /> : null)}
       </Layer>
      </Box>
      <SearchBar />
      <Minibuffer />
    </Box>
  );
}
