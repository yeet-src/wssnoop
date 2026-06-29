/* wssnoop/peers — best-effort remote endpoints for a process's TCP connections,
 * from the system graph. The BPF tap learns a connection's wss:// URL only from
 * the HTTP upgrade handshake; a connection that predates the attach has no
 * handshake, so its dest stays "?". The kernel still knows each socket's peer
 * address, so we recover it: a process's socket fd shares an inode with a
 * /proc/net/tcp entry, which carries the remote ip:port.
 *
 * This deliberately stays process-level. It can't map a specific SSL* stream to
 * a specific socket — node's TLS uses memory BIO pairs, so the SSL object holds
 * no fd to read. So it exposes the *set* of endpoints a process is connected to:
 * when that set is a single endpoint a handshake-less dest is unambiguous and we
 * fill it (`inferredDest`); otherwise the UI shows the set as a peers hint and
 * leaves dest "?". Lazy + cached + polled, like procinfo.
 *
 *   resolvePeers(pid)        // fire-and-forget; cached, cheap to call per render
 *   peerInfo.get()[pid]      // -> { endpoints: string[] } | undefined
 *   inferredDest(pid)        // -> "ip:port" when exactly one endpoint, else null
 *   destOf(conn)             // handshake dest, falling back to an inferred peer
 */

import { signal } from "yeet:tui";

const info = signal({}); // pid -> { endpoints }
const seen = new Set(); // pids we're tracking

export const peerInfo = info;

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

/* A handshake-less dest is unambiguous only when the process talks to exactly
 * one endpoint — then every stream of that process must be to it. */
export const inferredDest = (pid) => {
  const eps = info.get()[pid]?.endpoints;
  return eps && eps.length === 1 ? eps[0] : null;
};

/* The dest to display: the real wss:// URL from the handshake, else an inferred
 * peer marked "~" (so it never reads as a captured URL), else "?". */
export const destOf = (conn) => {
  if (conn.dest !== "?") return conn.dest;
  const ep = inferredDest(conn.pid);
  return ep ? `~${ep}` : "?";
};

/* Self-explaining tooltip for the dest, covering all three states: a captured
 * URL, an inferred sole endpoint, or genuinely unknown (with the peer set when
 * the ambiguity is the reason). */
export const destTip = (conn) => {
  if (conn.dest !== "?") return `destination · ${conn.dest}`;
  const ep = inferredDest(conn.pid);
  if (ep)
    return `destination (inferred) · ${ep} · no handshake seen (the connection predates the attach), but it's the process's only socket endpoint, so the stream must be it`;
  const eps = peerInfo.get()[conn.pid]?.endpoints || [];
  return eps.length
    ? `destination unknown · predates the attach (no handshake) and the process has several socket endpoints, so it can't be pinned to one: ${eps.join(", ")}`
    : `destination unknown · the connection predates the attach, so its wss:// URL (sent in the handshake) was never captured`;
};
