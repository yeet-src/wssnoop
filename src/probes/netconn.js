/* wssnoop/netconn — the socket-layer object (bin/socket.bpf.o), owned here and
 * shared by its two consumers:
 *
 *   connections            layer-1 discovery: the live set of outbound TCP
 *                          connections on the box (fexit/tcp_connect + tcp_close),
 *                          the browse list you pick tap targets from. Cheap
 *                          (per-connection), so it runs whenever watched.
 *
 *   subscribeFrames(cb)    the plaintext ws:// capture stream (tcp_sendmsg/recvmsg).
 *   armPlaintext(pid)      emit plaintext only for armed pids — a kernel-side set.
 *   disarmPlaintext(pid)   an empty set emits nothing, so an idle host is free.
 *
 * Plaintext is the fallback tap: state.js arms a pid here only when its SSL
 * uprobe attach failed (a non-OpenSSL process), so an OpenSSL wss client stays
 * on the SSL tap and its ciphertext never floods this ringbuf.
 *
 * The object is a lazy singleton (loaded once, kept for the app's life) because
 * both consumers share it and discovery is meant to stay warm; the isolate
 * teardown reclaims it. */

import { BpfObject, RingBuf, HashMap } from "yeet:bpf";
import { from } from "yeet:tui";

// socket.bpf.o sits beside probe.bpf.o; same bundle-vs-source path dance as
// probe.js (bundled → src/index.jsx, dirname = src/, so ../bin).
const inBundle = import.meta.filename.endsWith("/index.jsx");
const BIN_DIR = inBundle ? "../bin" : "../../bin";

const CONN_CLOSE = 1;
const AF_INET6 = 10;
const PUBLISH_MS = 500; // one snapshot per window, not per event (churn is bursty)

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

/* The one socket object, loaded on first use. Binds both ringbufs and the
 * focus-pid set up front so every consumer shares one control handle. */
let socketP = null;
function socket() {
  if (!socketP) {
    socketP = new BpfObject({ exe: `${BIN_DIR}/socket.bpf.o`, base: import.meta.dirname })
      .bind("conns", { kind: "ringbuf", btf_struct: "conn_event" })
      .bind("frames", { kind: "ringbuf", btf_struct: "ssl_event" })
      .bind("focus_pids", { kind: "hash_map" })
      .start()
      .then((ctl) => ({ ctl, focusPids: new HashMap(ctl, "focus_pids") }));
  }
  return socketP;
}

export const connections = from((state) => {
  const live = new Map(); // sk -> { sk, pid, family, addr, port, ts }
  let dirty = false;

  const subP = socket().then(({ ctl }) =>
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
  };
}, []);

/* Subscribe the plaintext frame stream (one subscription serves every armed
 * pid — the events are demuxed downstream by pid+sock). Returns an unsubscribe. */
export function subscribeFrames(onEvent) {
  const subP = socket().then(({ ctl }) =>
    new RingBuf(ctl, "frames").subscribe((w) => {
      const e = w?.ssl_event ?? w;
      if (e) onEvent(e);
    }),
  );
  return () => subP.then((s) => s.unsubscribe()).catch(() => {});
}

/* Add / remove a pid from the kernel-side plaintext focus set. Best-effort:
 * a delete of a pid never armed rejects (NotFound), which we ignore. */
export function armPlaintext(pid) {
  return socket().then(({ focusPids }) => focusPids.update(pid, 1)).catch(() => {});
}
export function disarmPlaintext(pid) {
  return socket().then(({ focusPids }) => focusPids.delete(pid)).catch(() => {});
}
