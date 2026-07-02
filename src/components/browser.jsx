/* wssnoop/browser — the layer-1 discovery view: the host-wide connection list
 * you pick tap targets from. netconn (fexit/tcp_connect) gives every outbound
 * TCP connection with its pid at near-zero cost; this groups them by process,
 * keeps the ones running a known TLS runtime (the confidently-tappable set) plus
 * anything already armed, and lets you click one to attach a pid-scoped SSL tap.
 * Nothing is decoded until you do, so an idle host stays cheap.
 *
 * A swap-in overlay like the inspector: while it's open the table isn't drawn.
 * Every row is a clickable Box (the app is mouse-driven) that toggles arming. */

import { Box, Text, bold, fg } from "yeet:tui";

import { connections } from "../probes/netconn.js";
import { procInfo, resolve } from "../probes/procinfo.js";
import { containers } from "../probes/containers.js";
import { runtimeOf } from "../probes/discover.js";
import { isArmed, toggleArm } from "../controls.js";
import { COL } from "../palette.js";
import { hoverBg, hoverTip } from "./hover.js";

const distinctPeers = (arr) => new Set(arr.map((c) => `${c.addr}:${c.port}`)).size;
const sample = (arr) => (arr.length ? `${arr[0].addr}:${arr[0].port}` : "");
const labelOf = (id, pid) => id?.label ?? `pid ${pid}`;

export default function Browser() {
  return (
    <Box direction="column" width="1fr" height="1fr" bg={COL.panel} padding={[1, 2]}>
      <Text height={1}>{bold(fg(COL.title)("Connections"))}</Text>
      <Text height={1} fg={COL.dim}>
        {"pick a process to decode · click a row to arm / disarm · c or Esc to close"}
      </Text>
      <Text height={1}>{" "}</Text>
      <Box height="1fr" overflow="hidden">
        {() => {
          const conns = connections.get();
          const info = procInfo.get();
          const cmap = containers.get();

          /* Group live connections by pid; resolve identity for labels (cached,
           * so calling per render is cheap — it queries a pid only once). */
          const byPid = new Map();
          for (const c of conns) {
            resolve(c.pid);
            let a = byPid.get(c.pid);
            if (!a) byPid.set(c.pid, (a = []));
            a.push(c);
          }

          /* Keep known TLS runtimes (they resolve cleanly to an SSL binary) plus
           * anything already armed, so you can always disarm what you started. */
          const rows = [];
          let hidden = 0;
          for (const [pid, arr] of byPid) {
            const id = info[pid];
            const runtime = runtimeOf(id?.exe, id?.comm);
            if (!runtime && !isArmed(pid)) {
              hidden += 1;
              continue;
            }
            rows.push({ pid, arr, runtime, id });
          }
          rows.sort((a, b) => b.arr.length - a.arr.length);

          if (rows.length === 0) {
            return (
              <Text break="none" italic fg={COL.dim}>
                {conns.length
                  ? `  ${byPid.size} process(es) connecting, none a recognized TLS runtime yet…`
                  : "  watching for outbound connections…"}
              </Text>
            );
          }

          const list = rows.map((r) => {
            const key = `browser:${r.pid}`;
            const armed = isArmed(r.pid);
            const cid = r.id?.container ?? null;
            const cname = cid ? cmap[cid]?.name ?? cid : null;
            const label = labelOf(r.id, r.pid);
            const peers = distinctPeers(r.arr);
            return (
              <Box
                direction="row"
                height={1}
                gap={2}
                break="none"
                bg={hoverBg(key)}
                onClick={(e) => (toggleArm(r.pid), e.stopPropagation())}
                {...hoverTip(key, () =>
                  isArmed(r.pid)
                    ? `stop decoding ${label} (pid ${r.pid})`
                    : `decode ${label} (pid ${r.pid}) · attaches a uprobe scoped to just this process`,
                )}
              >
                <Text width={2}>{armed ? fg(COL.accent)("●") : fg(COL.dim)("○")}</Text>
                <Text width={8}>{fg(COL.dim)((r.runtime ?? "?").padEnd(8))}</Text>
                <Box width="1fr" overflow="ellipsis" break="none">
                  <Text>{armed ? bold(fg(COL.ink)(label)) : fg(COL.dim)(label)}</Text>
                </Box>
                {cname ? <Text width={16} overflow="ellipsis" break="none">{fg(COL.server)(`⬢ ${cname}`)}</Text> : null}
                <Text width={10}>{fg(COL.dim)(`${r.arr.length} conn${r.arr.length === 1 ? "" : "s"}`)}</Text>
                <Text width={24} overflow="ellipsis" break="none">
                  {fg(COL.dim)(peers > 1 ? `→ ${peers} hosts` : `→ ${sample(r.arr)}`)}
                </Text>
              </Box>
            );
          });

          if (hidden > 0) {
            list.push(
              <Text height={1} italic fg={COL.dim}>{`  + ${hidden} other connecting process(es) (not a recognized TLS runtime)`}</Text>,
            );
          }
          return list;
        }}
      </Box>
    </Box>
  );
}
