/* wssnoop/row — one WebSocket connection as a table row: role, destination, a
 * message-count summary, and the activity sparkline filling the rest. Pure UI
 * over a *live* Conn object (state.js mutates it in place) — so the cells read
 * through a clock thunk: role/dest land only when the handshake arrives (often
 * after the first frame), and the counts climb every tick, with no new snapshot.
 *
 * `order` (rank) and `visible` (collapse slice + activeOnly) are thunks from the
 * group: re-ranking re-flows the layout order and hiding collapses the row to height
 * 0, neither rebuilding the row. Widths come from columns.js so rows align. */

import { Box, Text, face, fg } from "yeet:tui";

import Sparkline from "./sparkline.jsx";
import Pair from "../ui/pair.jsx";
import { COL, roleColor } from "../palette.js";
import { W_ROLE, W_MSG, GAP, INDENT, HANDLE } from "./columns.js";
import { inspect, searchHasFields, tableMatcher } from "../controls.js";
import { destOf, destTip } from "../probes/peers.js";
import { tip, hoverTip, hoverBg } from "../ui/tooltip.js";

const matchTip = (c) =>
  `search matches · messages matching the active $.field query on this connection / total retained (${c.msgs.size})`;

const roleTip = (c) =>
  c.role === "client"
    ? "role: client · this process opened the connection"
    : c.role === "server"
      ? "role: server · this process is serving the connection"
      : "role: unknown · attached mid-stream (no handshake seen)";

export default function Row({ conn, now, span, geom, order, visible, depth = 0 }) {
  return (
    <Box
      direction="row"
      order={order}
      height={() => (visible() ? 1 : 0)}
      overflow="hidden"
      bg={hoverBg(conn.key)}
      onClick={(e) => {
        inspect(conn);
        e.stopPropagation();
      }}
      {...hoverTip(conn.key, () => `connection #${conn.conn} · click to inspect its messages`)}
    >
      {/* a connection nests one level under its process header; under a
          container that's one deeper. The left region keeps its width, so the
          indent eats into DEST but the sparklines stay column-aligned. */}
      <Box width={geom.left} direction="row" gap={GAP} padding={[0, 0, 0, (depth + 1) * INDENT]} break="none">
        <Box width={W_ROLE} overflow="hidden" break="none" {...tip(() => roleTip(conn))}>
          {/* role colour is per-value, so a runtime face() patch, not a static attr */}
          <Text>{() => (now.get(), face({ fg: roleColor(conn.role) })(conn.role))}</Text>
        </Box>
        <Box width={geom.dest} overflow="ellipsis" break="none" {...tip(() => destTip(conn))}>
          <Text fg={COL.dim}>{() => (now.get(), destOf(conn))}</Text>
        </Box>
        {/* MSG column: normally sent/received counts, but while a `$.field`
            search is active it shows this connection's matching / total messages
            (flagged when any hit) — so you see which service the matches sit on. */}
        <Box width={W_MSG} overflow="hidden">
          {() =>
            searchHasFields() ? (
              <Box direction="row" width="fit" height={1} break="none" {...tip(() => matchTip(conn))}>
                <Text break="none">
                  {() => {
                    now.get();
                    const hit = conn.msgs.count(tableMatcher.get().test);
                    return fg(hit > 0 ? COL.warn : COL.dim)(`${hit}/${conn.msgs.size}`);
                  }}
                </Text>
              </Box>
            ) : (
              <Pair
                desc="messages on this connection"
                sep=" "
                up={{ color: COL.out, label: "sent (↑)", text: () => (now.get(), `${conn.msgUp}↑`) }}
                down={{ color: COL.in, label: "received (↓)", text: () => (now.get(), `${conn.msgDn}↓`) }}
              />
            )
          }
        </Box>
      </Box>
      <Box width={HANDLE} break="none" />
      <Sparkline hist={conn.hist} now={now} span={span} width={geom.spark} originX={geom.left + HANDLE} variant="conn" />
    </Box>
  );
}
