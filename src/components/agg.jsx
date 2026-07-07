/* wssnoop/agg — the per-node aggregate figure shown on every header (a process
 * group, a container, the ALL row). It has two modes, both live (they read the
 * heartbeat so the numbers climb without the header rebuilding):
 *
 *   normal      — egress (↑) over ingress (↓), in the metric the toolbar's `agg`
 *                 toggle selects: total bandwidth (bytes, the default — egress
 *                 cost is the headline concern) or message count.
 *   search hits — when a `$.field` query is active, the figure becomes matching
 *                 / total messages for this node, flagged when any match. This
 *                 is the error/tag workflow: search `$.error`, see per-service
 *                 how many messages hit, without a bespoke feature.
 *
 * `conns` is a thunk yielding the node's connection list (message counts and
 * match counts are summed from the live conns); `hist` supplies the byte totals
 * (a live TimeHist, or a merged one); `now` keeps both live. */

import { Box, Text, fg } from "yeet:tui";

import { aggMetric, tableMatcher, search, tip } from "../controls.js";
import { COL } from "../palette.js";
import { fmtBytes } from "../lib/fmt.js";

const twoTone = (up, dn) => [fg(COL.out)(up), fg(COL.dim)(" "), fg(COL.in)(dn)];

const aggTip = () =>
  tableMatcher.get().fields
    ? `search matches · messages matching “${search.get()}” / total on this node · a live per-service count for the error/tag workflow`
    : "aggregate · ↑ sent / ↓ received · bandwidth or messages (toggle with agg / m)";

export default function Agg({ hist, conns, now }) {
  return (
    <Box direction="row" width="fit" height={1} break="none" {...tip(aggTip)}>
      <Text break="none">
        {() => {
          now?.get?.();
          const m = tableMatcher.get();
          if (m.fields) {
            let matched = 0;
            let total = 0;
            for (const c of conns()) {
              matched += c.msgs.count(m.test);
              total += c.msgs.size;
            }
            return [fg(matched > 0 ? COL.warn : COL.dim)(`${matched}`), fg(COL.dim)(`/${total} match`)];
          }
          if (aggMetric.get() === "bytes") return twoTone(`↑${fmtBytes(hist.totalUp)}`, `↓${fmtBytes(hist.totalDown)}`);
          let up = 0;
          let dn = 0;
          for (const c of conns()) {
            up += c.msgUp;
            dn += c.msgDn;
          }
          return twoTone(`↑${up}`, `↓${dn}`);
        }}
      </Text>
    </Box>
  );
}
