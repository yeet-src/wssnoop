/* wssnoop/row — one WebSocket connection as a table row: role, destination, a
 * message-count summary, and the activity sparkline filling the rest. Pure UI
 * over a *live* Conn object (state.js mutates it in place) — so the cells read
 * through a clock thunk: role/dest land only when the handshake arrives (often
 * after the first frame), and the counts climb every tick, with no new snapshot.
 *
 * `order` (rank) and `visible` (collapse slice + activeOnly) are thunks from the
 * group: re-ranking re-flows the layout order and hiding collapses the row to height
 * 0, neither rebuilding the row. Widths come from columns.js so rows align. */

import { Box, Text, fg } from "yeet:tui";

import Sparkline from "./sparkline.jsx";
import { COL, roleColor } from "./palette.js";
import { INDENT, W_ROLE, W_DEST, W_MSG, GAP, LEFT } from "./columns.js";
import { tip, inspect } from "../controls.js";

const roleTip = (c) =>
  c.role === "client"
    ? "role: client — this process opened the connection"
    : c.role === "server"
      ? "role: server — this process is serving the connection"
      : "role: unknown — attached mid-stream (no handshake seen)";

export default function Row({ conn, now, span, width, order, visible }) {
  return (
    <Box
      direction="row"
      order={order}
      height={() => (visible() ? 1 : 0)}
      overflow="hidden"
      onClick={(e) => {
        inspect(conn.key);
        e.stopPropagation();
      }}
      {...tip(() => `connection #${conn.conn} — click to inspect its messages`)}
    >
      <Box width={LEFT} direction="row" gap={GAP} padding={[0, 0, 0, INDENT]} break="none">
        <Box width={W_ROLE} overflow="hidden" break="none" {...tip(() => roleTip(conn))}>
          <Text>{() => (now.get(), fg(roleColor(conn.role))(conn.role))}</Text>
        </Box>
        <Box width={W_DEST} overflow="ellipsis" break="none" {...tip(() => `destination: ${conn.dest}`)}>
          <Text>{() => (now.get(), fg(COL.dim)(conn.dest))}</Text>
        </Box>
        <Box
          width={W_MSG}
          overflow="hidden"
          {...tip(() => `messages: ${conn.msgUp} sent (↑) · ${conn.msgDn} received (↓)`)}
        >
          <Text break="none">
            {() => (now.get(), [fg(COL.out)(`${conn.msgUp}↑`), " ", fg(COL.in)(`${conn.msgDn}↓`)])}
          </Text>
        </Box>
      </Box>
      <Sparkline hist={conn.hist} now={now} span={span} width={width} variant="conn" />
    </Box>
  );
}
