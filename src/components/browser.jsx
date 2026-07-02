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
import { procInfo, resolve, sslInfo, classifySsl } from "../probes/procinfo.js";
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
          const scls = sslInfo.get();
          const cmap = containers.get();

          /* Group live connections by pid; resolve identity + SSL class for each
           * (both cached, queried once per pid, so calling per render is cheap). */
          const byPid = new Map();
          for (const c of conns) {
            resolve(c.pid);
            classifySsl(c.pid);
            let a = byPid.get(c.pid);
            if (!a) byPid.set(c.pid, (a = []));
            a.push(c);
          }

          /* Keep processes with reachable TLS — a mapped libssl (any language) or
           * a static-OpenSSL runtime — plus anything already armed, so you can
           * always disarm what you started. Class-driven, not a name list, so a
           * Rust native-tls or dynamically-linked C++ app shows up too. A pid
           * still being classified is held back until its class arrives. */
          const rows = [];
          let hidden = 0;
          for (const [pid, arr] of byPid) {
            const id = info[pid];
            const cls = scls[pid];
            if (!isArmed(pid)) {
              if (cls == null) continue; // still classifying
              if (cls === "opaque") { hidden += 1; continue; }
            }
            const tag = runtimeOf(id?.exe, id?.comm) ?? (cls === "libssl" ? "libssl" : "?");
            rows.push({ pid, arr, tag, id });
          }
          /* Stable order by pid — a busy process gaining connections must not
           * reshuffle rows under the pointer (arming would land on the wrong
           * one). pid is fixed for a process's life, so the list stays put. */
          rows.sort((a, b) => a.pid - b.pid);

          if (rows.length === 0) {
            return (
              <Text break="none" italic fg={COL.dim}>
                {conns.length
                  ? `  ${byPid.size} process(es) connecting, none with reachable TLS yet…`
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
                <Text width={8}>{fg(COL.dim)(r.tag.padEnd(8))}</Text>
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
              <Text height={1} italic fg={COL.dim}>{`  + ${hidden} other connecting process(es) (no reachable TLS — Go/rustls/stripped or non-TLS)`}</Text>,
            );
          }
          return list;
        }}
      </Box>
    </Box>
  );
}
