/* wssnoop/netconn — layer-1 discovery as a signal: the live set of outbound TCP
 * connections on the box, keyed by their kernel sock, built from the standalone
 * discover.bpf.o (fexit/tcp_connect + tcp_close). No SSL tap, no per-byte cost —
 * this is the cheap "where is the traffic" map the UI browses before deciding
 * which process to actually tap.
 *
 *   connections.get()  // -> [{ sk, pid, family, addr, port, ts }, …]
 *
 * The BPF object auto-attaches its kernel-global probes on start(); the from()
 * lifecycle loads it while watched and detaches when not, so discovery runs only
 * while something reads the signal. */

import { BpfObject, RingBuf } from "yeet:bpf";
import { from } from "yeet:tui";

// discover.bpf.o sits beside probe.bpf.o; same bundle-vs-source path dance as
// probe.js (bundled → src/index.jsx, dirname = src/, so ../bin).
const inBundle = import.meta.filename.endsWith("/index.jsx");
const BIN_DIR = inBundle ? "../bin" : "../../bin";

const CONN_CLOSE = 1;
const AF_INET6 = 10;

/* Remote address as a string. v4 lives in the first 4 bytes; v6 is 8 hextets
 * (no ::-compression — the map is for eyeballing, not canonical form). */
function addrOf(family, r) {
  if (family === AF_INET6) {
    let out = "";
    for (let i = 0; i < 8; i++) out += (i ? ":" : "") + (((r[i * 2] << 8) | r[i * 2 + 1]) >>> 0).toString(16);
    return out;
  }
  return `${r[0]}.${r[1]}.${r[2]}.${r[3]}`;
}

const PUBLISH_MS = 500; // one snapshot per window, not per event (churn is bursty)

export const connections = from((state) => {
  const live = new Map(); // sk -> { sk, pid, family, addr, port, ts }
  let dirty = false;

  const ctlP = new BpfObject({ exe: `${BIN_DIR}/discover.bpf.o`, base: import.meta.dirname })
    .bind("conns", { kind: "ringbuf", btf_struct: "conn_event" })
    .start();

  const subP = ctlP.then((ctl) =>
    new RingBuf(ctl, "conns").subscribe((w) => {
      const e = w?.conn_event ?? w;
      if (!e) return;
      const sk = e.sk; // BigInt — a stable per-connection id
      if (e.event === CONN_CLOSE) live.delete(sk);
      else live.set(sk, { sk, pid: e.pid, family: e.family, addr: addrOf(e.family, e.raddr), port: e.rport, ts: Number(e.ts) });
      dirty = true;
    }),
  );

  const h = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    state.set([...live.values()]);
  }, PUBLISH_MS);

  return () => {
    clearInterval(h);
    subP.then((s) => s.unsubscribe()).catch(() => {});
    ctlP.then((c) => c.stop()).catch(() => {});
  };
}, []);
