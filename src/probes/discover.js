/* discover — work out which binary holds SSL_read/SSL_write, from the system
 * graph alone. This is the only knowledge probe.js needs before it can attach,
 * and it's pure with respect to BPF: its sole dependency is a graph query
 * function, injected (defaulting to the global `yeet.graph`) so the whole thing
 * unit-tests against a fake graph with no daemon. probe.js owns the BPF
 * lifecycle and imports `resolveBin` from here.
 *
 * SSL lives in different places, and a container hides it behind a mount
 * namespace, so every resolution ends the same way: identify a pid, then take
 * that pid's SSL-bearing path *through its namespace root* (`/proc/<pid>/root`),
 * which is host-attachable whether the process is on the host or in a container.
 *
 *   - an explicit path ("/usr/bin/node") or library name ("libssl.so") → as-is.
 *   - a bare program name ("node")   → a matching process's SSL path.
 *   - nothing, but a --pid is given  → that process's SSL path.
 *   - nothing and no pid             → the first running known runtime's path.
 *   - anything unresolved            → "libssl.so", the dynamic-linking default.
 */

import { containerOf } from "../lib/container.js";
import { KNOWN_BINS, classify, libsslPath, nameMatches } from "./runtimes.js";

export const DEFAULT_BIN = "libssl.so";

/* An explicit target needs no discovery: a path, a `.so`, or a libssl name. */
export const isExplicit = (b) => b.includes("/") || b.endsWith(".so") || b.includes(".so.") || /libssl/i.test(b);

/* The coarse tappability class the pre-registry code exposed, kept for callers
 * that only need the three-way split (procinfo caches the richer classify()):
 *   "libssl"  — maps a libssl (dynamic OpenSSL), any language.
 *   "runtime" — a known static-OpenSSL runtime (node/deno/bun).
 *   "opaque"  — neither decodable-by-known-means: Go/rustls/stripped/unknown.
 * See runtimes.classify for the full { label, tap, decodable }. */
export const sslClass = (proc) => {
  const c = classify(proc);
  return c.tap === "libssl" ? "libssl" : c.decodable ? "runtime" : "opaque";
};

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("graph timeout")), ms));
const race = (p, ms) => Promise.race([p, timeout(ms)]);

/* Lazy so importing this module off-isolate (a test that always injects a
 * graph) never touches the `yeet` global. */
const defaultGraph = () => yeet.graph;

/* Rewrite an in-process path to one the host can open: `/proc/<pid>/root` is the
 * process's mount-namespace root, so a container's own /usr/bin/node becomes
 * reachable from the host. For a host process the root is just `/`, so the path
 * points at the same inode either way. */
const nsPath = (pid, path) => `/proc/${pid}/root${path.startsWith("/") ? "" : "/"}${path}`;

/* The SSL-bearing binary for one pid: a mapped libssl wins (dynamic linking),
 * else the exe (static), taken through the namespace root so a containerized
 * process's binary is host-attachable. This is what lets `--pid <container-pid>`
 * trace inside a container. Returns null when the pid has no exe/maps. */
async function sslForPid(pid, graph) {
  const { data } = await graph.query(`{ proc(pid: ${pid}) { exe maps { path } } }`);
  const p = data?.proc;
  if (!p) return null;
  const lib = libsslPath((p.maps || []).map((m) => m.path));
  const path = lib || p.exe || null;
  return path ? nsPath(pid, path) : null;
}

/* The pid of a running process whose exe-basename or comm matches `name`. */
async function pidForName(name, graph) {
  const { data } = await graph.query(`{ procs { stat { pid comm } exe } }`);
  const hit = (data?.procs || []).find((p) => nameMatches(p.exe, p.stat?.comm, name));
  return hit?.stat?.pid ?? null;
}

/* The first running known-runtime pid, in KNOWN_BINS preference order. */
async function pidForKnownRuntime(graph) {
  const { data } = await graph.query(`{ procs { stat { pid comm } exe } }`);
  const procs = data?.procs || [];
  for (const name of KNOWN_BINS) {
    const hit = procs.find((p) => nameMatches(p.exe, p.stat?.comm, name));
    if (hit?.stat?.pid != null) return hit.stat.pid;
  }
  return null;
}

/* Every resolution that has a pid ends by taking that pid's SSL path, so a
 * container's binary is reached the same way no matter which route found it. A
 * pidless resolution (a --pid that's gone, an unmatched name) yields null. */
async function binForPid(pid, graph) {
  return pid != null ? sslForPid(pid, graph) : null;
}

/* Enumerate the distinct traceable binaries on the box — what a no-args launch
 * chooses between. Cheap by design: ONE procs query, NO per-pid maps query (the
 * attachable path is resolved lazily with resolveBin, only for the target that
 * gets picked — a maps query is the heavy one, YEET-DX-NOTES.md #10).
 *
 * Two processes are the same target when they share an exe AND a container: a
 * bin-wide uprobe attaches to an inode, and a host runtime and its containerized
 * twin are different inodes (different mount namespaces), so they list
 * separately. That split is exactly when the picker is worth showing — one
 * distinct binary means the launcher can just attach it, no prompt.
 *
 * Returns `[{ runtime, exe, container: {id}|null, pids: [pid,…] }, …]`, container
 * name/image left to the caller (it has the docker registry). */
export async function discoverTargets(graph = defaultGraph()) {
  const { data } = await graph.query(`{ procs { stat { pid comm } exe cgroups { pathname } } }`);
  const byBinary = new Map();
  for (const p of data?.procs || []) {
    const exe = p.exe || "";
    const runtime = KNOWN_BINS.find((n) => nameMatches(exe, p.stat?.comm, n));
    if (!runtime) continue;
    const cid = containerOf(p.cgroups);
    const key = `${cid ?? ""}\0${exe}`;
    let t = byBinary.get(key);
    if (!t) byBinary.set(key, (t = { runtime, exe, container: cid ? { id: cid } : null, pids: [] }));
    if (p.stat?.pid != null) t.pids.push(p.stat.pid);
  }
  return [...byBinary.values()];
}

export async function resolveBin({ bin, pid }, graph = defaultGraph()) {
  if (bin && isExplicit(bin)) return bin; // already a path or a library name
  /* Pick the discovery route, then race the WHOLE chain (a name/known-runtime
   * route makes two graph queries — the pid lookup and the maps lookup — and
   * both must fit the one budget). */
  const route =
    !bin && pid != null
      ? () => binForPid(pid, graph)
      : bin
        ? async () => binForPid(await pidForName(bin, graph), graph)
        : async () => binForPid(await pidForKnownRuntime(graph), graph);
  try {
    const target = await race(route(), 1500);
    if (target) return target;
  } catch {
    /* discovery failed/timed out — fall back to the dynamic-linking default (a
     * heavy maps query can time out; discovery is a convenience, never a way to
     * wedge startup — see YEET-DX-NOTES.md #10). */
  }
  return DEFAULT_BIN;
}
