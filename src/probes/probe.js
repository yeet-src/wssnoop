/* wssnoop/probe — the capture half: attach the BPF program at the OpenSSL
 * boundary and stream raw `ssl_event` records up from the ringbuf. The only
 * BPF-aware module: it owns the whole BPF lifecycle (load, bind, attach,
 * subscribe, teardown) and knows nothing about what the bytes mean — that's
 * lib/decode.js's job. */

import { BpfObject, RingBuf, ArrayMap } from "yeet:bpf";

// bin/probe.bpf.o sits at the project root (src/bpf/wssnoop.bpf.c links into
// it — see build/bpf.mk). `base: import.meta.dirname` anchors the lookup on
// this module's directory, which differs by one level between the two ways
// the project runs: bundled, everything is flattened into src/index.jsx
// (dirname = src/, so ../bin); run straight from source for a faster loop
// (`yeet run src/main.jsx`), this file stays at src/probes/ (dirname one
// deeper, so ../../bin). Detect the bundle by its entry filename.
const inBundle = import.meta.filename.endsWith("/index.jsx");
const BIN_DIR = inBundle ? "../bin" : "../../bin";

const base = (p) => (p || "").split("/").pop() || "";

/* Resolve the binary that *holds* SSL_read/SSL_write into an attachable target.
 * The uprobe attach doesn't $PATH-resolve, and SSL lives in different places —
 * a mapped `libssl.so` for dynamically-linked programs, the executable itself
 * for statically-linked ones (node, some Python builds). So:
 *
 *   - an explicit path ("/usr/bin/node") or library name ("libssl.so") → as-is.
 *   - a bare program name ("node") → the exe of a running process that matches,
 *     resolved to an absolute path.
 *   - nothing, but a --pid is given → that process's mapped libssl, else its exe.
 *   - nothing and no pid → "libssl.so", the dynamic-linking common case.
 *
 * All graph lookups are raced against a short timeout and fall back to
 * "libssl.so": discovery is a convenience, never a way to wedge startup (a maps
 * query can be heavy — see YEET-DX-NOTES.md #10). */
const DEFAULT_BIN = "libssl.so";
const isExplicit = (b) => b.includes("/") || b.endsWith(".so") || b.includes(".so.") || /libssl/i.test(b);

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("graph timeout")), ms));
const race = (p, ms) => Promise.race([p, timeout(ms)]);

/* The SSL-bearing binary for one pid: a mapped libssl wins (dynamic linking),
 * else the exe (static). Resolved *through the target's mount-namespace root*
 * (`/proc/<pid>/root/...`) so a containerized process's node/libssl — an
 * in-container path the host can't open directly — becomes host-attachable. For
 * a host process `/proc/<pid>/root` is just `/`, so the path is unchanged. This
 * is what lets `--pid <container-pid>` trace a process inside a container. */
async function sslForPid(pid) {
  const { data } = await yeet.graph.query(`{ proc(pid: ${pid}) { exe maps { path } } }`);
  const p = data?.proc;
  if (!p) return null;
  const lib = (p.maps || []).map((m) => m.path).find((x) => x && /libssl/i.test(x));
  const path = lib || p.exe || null;
  return path ? `/proc/${pid}/root${path.startsWith("/") ? "" : "/"}${path}` : null;
}

/* Absolute exe of a running process whose exe-basename or comm matches `name`. */
async function exeForName(name) {
  const { data } = await yeet.graph.query(`{ procs { exe stat { comm } } }`);
  const hit = (data?.procs || []).find((p) => p.exe && (base(p.exe) === name || p.stat?.comm === name));
  return hit?.exe ?? null;
}

export async function resolveBin({ bin, pid }) {
  if (bin && isExplicit(bin)) return bin; // already a path or a library name
  try {
    if (!bin && pid != null) {
      const found = await race(sslForPid(pid), 1500);
      if (found) return found;
    } else if (bin) {
      const found = await race(exeForName(bin), 1500);
      if (found) return found;
    }
  } catch {
    /* discovery failed/timed out — fall back to the dynamic-linking default */
  }
  return DEFAULT_BIN;
}

/* Attach the SSL_write and SSL_read uprobes in `bin` (scoped to `pid` when
 * given), delivering each plaintext chunk to onEvent(rawEvent) and any
 * transport fault to onError(err). Returns a session whose stop() detaches.
 *
 *   const session = await snoop({ bin, pid, onEvent, onError });
 */
export async function snoop({ bin, pid, onEvent, onError, onBin, plaintext = false }) {
  const probe = new BpfObject({
    exe: `${BIN_DIR}/probe.bpf.o`,
    base: import.meta.dirname,
  });

  /* Discover where the SSL symbols live (path / library / process exe) before
   * attaching; report the resolved target so the UI can show what it hooked. */
  const target = await resolveBin({ bin, pid });
  onBin?.(target);

  // Each attaches as `kind: "uprobe"`; the daemon reads each program's ELF
  // section to tell entry (SEC("uprobe")) from return (SEC("uretprobe")).
  const uprobe = { kind: "uprobe", binary: target, pid };

  const control = await probe
    .bind("events", { kind: "ringbuf", btf_struct: "ssl_event" })
    .bind("focus", { kind: "array" }) // writable filter (slot 0 ssl, 1 pid, 2 tcp-enable)
    .attach("probe_ssl_write", { ...uprobe, symbol: "SSL_write" })
    .attach("probe_ssl_read_enter", { ...uprobe, symbol: "SSL_read" })
    .attach("probe_ssl_read_exit", { ...uprobe, symbol: "SSL_read" })
    .start();

  /* The user→kernel control path: write the BPF capture filter live so the
   * probe only emits the focused connection's (or process's) events. */
  const focus = new ArrayMap(control, "focus");
  const setFocus = async ({ ssl = 0n, pid = 0 } = {}) => {
    try {
      await focus.update(0, BigInt(ssl || 0));
      await focus.update(1, BigInt(pid || 0));
    } catch (err) {
      if (onError) onError(err);
    }
  };

  /* Plaintext ws:// capture is off by default (the tcp_sendmsg/recvmsg kprobes
   * fire host-wide); flip the kernel enable flag only when the user asked. */
  if (plaintext) {
    try {
      await focus.update(2, 1n);
    } catch (err) {
      if (onError) onError(err);
    }
  }

  const events = new RingBuf(control, "events");
  const sub = await events.subscribe(
    (wrapper) => {
      /* A throw here would escape into the runtime and tear down the
       * isolate, so keep faults local to the offending event. */
      try {
        const e = (wrapper && wrapper.ssl_event) || wrapper;
        if (e) onEvent(e);
      } catch (err) {
        if (onError) onError(err);
      }
    },
    (err) => {
      if (onError) onError(err);
    },
  );

  return {
    setFocus,
    async stop() {
      await sub.unsubscribe();
      await control.stop();
    },
  };
}
