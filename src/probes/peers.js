/* wssnoop/peers — best-effort remote endpoint for a connection whose wss:// URL
 * was never captured. The BPF tap learns the URL only from the HTTP upgrade
 * handshake; a connection that predates the attach has no handshake, so its
 * dest stays "?". Two kernel sources recover a peer for it, most-confident
 * first:
 *
 *   1. The socket-layer connect tap (netconn) records each outbound
 *      connection's exact remote ip:port, keyed by its `struct sock*`. A
 *      plaintext conn's `ssl` field IS that pointer, so it keys straight in —
 *      the precise endpoint even when the process has many. (A TLS conn's SSL*
 *      pointer simply misses.)
 *   2. Failing that, the system graph: a process's socket fds share inodes with
 *      /proc/net/tcp entries carrying the remote ip:port. This is process-level
 *      (node's TLS uses memory BIO pairs, so the SSL object holds no fd) — it
 *      exposes the *set* of endpoints; a sole endpoint is unambiguous, several
 *      leave the pin as a "one of N" hint. Lazy + cached + polled, like procinfo.
 *
 *   resolvePeers(pid)        // fire-and-forget; cached, cheap to call per render
 *   peerInfo.get()[pid]      // -> { endpoints: string[] } | undefined
 *   destOf(conn)             // handshake URL, else an inferred peer, else unknown #id
 *   destTip(conn)            // self-explaining tooltip for whichever of those it is
 */

import { computed, signal } from "yeet:tui";

import { connections } from "./netconn.js";

const info = signal({}); // pid -> { endpoints }
const seen = new Set(); // pids we're tracking

export const peerInfo = info;

/* sk (struct sock*) -> "ip:port", the exact peer of every live outbound
 * connection the connect tap has seen. A plaintext conn's `ssl` field is the
 * same pointer, so this pins its endpoint precisely. */
const connBySk = computed(() => {
  const m = new Map();
  for (const e of connections.get()) m.set(e.sk, `${e.addr}:${e.port}`);
  return m;
});
const socketDest = (conn) => {
  try {
    return connBySk.get().get(BigInt(conn.ssl)) ?? null;
  } catch {
    return null;
  }
};

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("graph timeout")), ms));
const race = (p, ms) => Promise.race([p, timeout(ms)]);

const TCP = `{ tcp { remote_address { addr } inode state } tcp6 { remote_address { addr } inode state } }`;

/* One global tcp/tcp6 snapshot (inode -> remote addr for ESTABLISHED sockets),
 * then each tracked pid's fds joined against it. Per-pid fds queries run
 * independently (Promise.allSettled) because `proc(pid)` *throws* for a dead pid
 * (DX #18) — one exited process mustn't blank every other's peers. */
async function poll() {
  if (seen.size === 0) return;
  let byInode;
  try {
    const { data } = await race(yeet.graph.query(TCP), 1500);
    byInode = new Map();
    for (const e of [...(data.tcp || []), ...(data.tcp6 || [])])
      if (e.state === "Established" && e.remote_address?.addr) byInode.set(String(e.inode), e.remote_address.addr);
  } catch {
    return; /* a failed snapshot leaves the last-known endpoints in place */
  }
  const pids = [...seen];
  const settled = await Promise.allSettled(
    pids.map((p) =>
      race(yeet.graph.query(`{ proc(pid: ${p}) { fds { inode } } }`), 1500).then(({ data }) => [p, data?.proc?.fds || []]),
    ),
  );
  const next = {};
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    const [p, fds] = r.value;
    const eps = new Set();
    for (const f of fds) {
      const a = byInode.get(String(f.inode));
      if (a) eps.add(a);
    }
    next[p] = { endpoints: [...eps] };
  }
  if (Object.keys(next).length) info.update((m) => ({ ...m, ...next }));
}

let timer = null;
export function resolvePeers(pid) {
  if (pid == null) return;
  if (!seen.has(pid)) {
    seen.add(pid);
    poll().catch(() => {});
  }
  if (timer == null) timer = setInterval(() => poll().catch(() => {}), 5000);
}

/* The best-known remote peer for a handshake-less conn, most-confident first:
 * the exact socket peer (plaintext), the process's sole /proc endpoint, else the
 * endpoint set (ambiguous — can't pin which). null when the kernel knows no peer
 * for the process at all. */
const inferPeer = (conn) => {
  const exact = socketDest(conn);
  if (exact) return { kind: "socket", addr: exact };
  const eps = info.get()[conn.pid]?.endpoints || [];
  if (eps.length === 1) return { kind: "sole", addr: eps[0] };
  if (eps.length > 1) return { kind: "ambiguous", addr: eps[0], eps };
  return null;
};

/* The dest to display: the real wss:// URL from the handshake, else an inferred
 * peer marked "~" (so it never reads as a captured URL) with a "+N" when it's
 * one of several candidates, else "unknown connection #<id>" — the word names
 * what's unknown, and the id is the connection's own display id (the same #a1b2
 * shown on hover), stable and distinct so several unknowns stay tellable apart. */
export const destOf = (conn) => {
  if (conn.dest !== "?") return conn.dest;
  const p = inferPeer(conn);
  if (!p) return `unknown connection #${conn.conn}`;
  return p.kind === "ambiguous" ? `~${p.addr} +${p.eps.length - 1}` : `~${p.addr}`;
};

/* Self-explaining tooltip for the dest, covering every state destOf can land in:
 * a captured URL, an exact socket peer, an inferred sole endpoint, one of several
 * candidates, or genuinely unknown. */
export const destTip = (conn) => {
  if (conn.dest !== "?") return `destination · ${conn.dest}`;
  const p = inferPeer(conn);
  if (!p)
    return `destination unknown · no wss:// URL was captured (the connection predates the attach, so its handshake was never seen) and the kernel reports no remote peer for the process; #${conn.conn} is this connection's id (shown on hover), a stable label to tell the unknowns apart`;
  if (p.kind === "socket")
    return `destination (peer) · ${p.addr} · no handshake seen, but the socket tap caught this connection's connect(), so this is its exact remote endpoint`;
  if (p.kind === "sole")
    return `destination (inferred) · ${p.addr} · no handshake seen (predates the attach), but it's the process's only socket endpoint, so the stream must be it`;
  return `destination · one of ${p.eps.length} · predates the attach (no handshake) and the process has several socket endpoints, so it can't be pinned to one: ${p.eps.join(", ")}`;
};
