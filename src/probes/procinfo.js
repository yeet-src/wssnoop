/* wssnoop/procinfo — process identity from the system graph. The BPF tap only
 * knows a pid; this resolves it to something human (comm / cmdline / exe) and,
 * where it can, the container it runs in. Lazy + cached: a pid is queried once,
 * the moment a group for it appears, then published into a reactive map the UI
 * reads. The data layer keys on pid; this is purely a presentation lookup, so
 * it lives in probes/ next to the other graph/BPF sources, not in state.js.
 *
 *   resolve(pid)          // fire-and-forget; cached, so cheap to call per render
 *   procInfo.get()[pid]   // -> { label, comm, cmdline, exe, container } | undefined
 */

import { signal } from "yeet:tui";

const info = signal({}); // pid -> identity, republished as each resolves
const seen = new Set(); // pids queried (resolved or in-flight) — query once each

export const procInfo = info;

const base = (p) => (p || "").split("/").pop() || "";

/* Interpreters whose own name (node/python/…) tells you nothing — the script
 * argument is the real identity. comm is also unhelpful here: node renames its
 * main thread to "MainThread", Python to the module, etc. */
const INTERP = new Set(["node", "deno", "bun", "python", "python3", "ruby", "java", "sh", "bash", "zsh"]);

/* A short, human label. Prefer comm, but when it's generic (a thread name, or
 * just the interpreter) fall back to the cmdline: `node server.js`, not
 * `MainThread`. */
export function procLabel(info) {
  if (!info) return null;
  const { comm, cmdline, exe } = info;
  const exeBase = base(exe);
  const head = base(cmdline?.[0]);
  const generic = !comm || comm === "MainThread" || comm === exeBase || INTERP.has(comm);
  if (generic && cmdline?.length) {
    const arg = cmdline.slice(1).find((a) => a && !a.startsWith("-"));
    return arg ? `${head || exeBase} ${base(arg)}` : head || exeBase || comm;
  }
  return comm || exeBase || null;
}

/* Best-effort container id from a cgroup path: docker / containerd / crio / k8s
 * all embed the 64-hex id in the cgroup path. Returns the short (12-char) form,
 * or null when the process isn't containerized. */
function containerOf(cgroups) {
  for (const c of cgroups || []) {
    const m = /(?:docker[-/]|containerd[-/]|crio-|libpod-)([0-9a-f]{12,64})/.exec(c.pathname || "");
    if (m) return m[1].slice(0, 12);
  }
  return null;
}

const QUERY = (pid) => `{ proc(pid: ${pid}) { cmdline exe stat { comm } cgroups { pathname } } }`;

const publish = (id) => {
  id.label = procLabel(id) || `pid ${id.pid}`;
  if (id.alive == null) id.alive = true; /* assume alive until liveness says otherwise */
  info.update((m) => ({ ...m, [id.pid]: id }));
};

export function resolve(pid) {
  startLiveness();
  if (pid == null || seen.has(pid)) return;
  seen.add(pid);
  yeet.graph
    .query(QUERY(pid))
    .then(({ data }) => {
      const p = data && data.proc;
      publish(
        p
          ? {
              pid,
              comm: p.stat?.comm ?? null,
              cmdline: p.cmdline ?? [],
              exe: p.exe ?? "",
              container: containerOf(p.cgroups),
            }
          : { pid, comm: null, cmdline: [], exe: "", container: null },
      );
    })
    .catch(() => publish({ pid, comm: null, cmdline: [], exe: "", container: null }));
}

/* Liveness — a stopped process keeps its rows until its connections idle out
 * (a *killed* process never sends a CLOSE, so its conns sit "open" for the full
 * retention window). Mark such a process so the UI can grey it. One cheap
 * `procs` query lists every live pid; any pid we've resolved that's absent has
 * exited. Polled lazily — the timer only starts once a group asks to resolve. */
let liveTimer = null;
async function pollLiveness() {
  if (seen.size === 0) return;
  try {
    const { data } = await yeet.graph.query(`{ procs { stat { pid } } }`);
    const live = new Set((data?.procs ?? []).map((p) => p.stat?.pid).filter((x) => x != null));
    for (const pid of seen) {
      const cur = info.get()[pid];
      if (!cur) continue;
      const alive = live.has(pid);
      if (cur.alive !== alive) info.update((m) => ({ ...m, [pid]: { ...cur, alive } }));
    }
  } catch {
    /* a failed poll just leaves the last-known liveness in place */
  }
}
function startLiveness() {
  if (liveTimer == null) liveTimer = setInterval(() => pollLiveness().catch(() => {}), 4000);
}
