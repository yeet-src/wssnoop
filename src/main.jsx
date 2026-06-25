/* wssnoop — decode the WebSocket traffic riding inside a process's TLS
 * connections, by tapping the plaintext at the OpenSSL boundary.
 *
 * The BPF half (src/bpf/wssnoop.bpf.c) uprobes SSL_write / SSL_read and ships
 * each plaintext chunk up a ringbuf, tagged with (pid, ssl-pointer, direction).
 * The pieces it feeds:
 *   probes/probe.js   — capture: owns the BPF lifecycle, streams raw chunks up.
 *   lib/decode.js     — data:    reassembles chunks per connection, walks the
 *                                HTTP upgrade, parses RFC-6455 frames into JS.
 *   components/view.jsx — present: renders decoded events in a live terminal UI.
 * This file is just the seam: parse args, then wire capture -> decode -> view.
 *
 * Run (against the demo node server in the VM):
 *   yeet run . -- --pid <node-pid> --bin <ssl-binary>
 *
 * --bin is where the SSL_read/SSL_write symbols live: a shared OpenSSL
 *   (e.g. `libssl.so`, the default — works when node links it dynamically,
 *   as Debian/apt node does) OR an absolute path to a statically-linked
 *   executable (e.g. `/usr/bin/node` from the official tarball/nodesource).
 *   Find it with:  readlink /proc/<pid>/exe   and   ldd that path | grep ssl
 * --pid scopes the probe to one process (strongly recommended; otherwise
 *   every process mapping --bin is traced). */

import { createView } from "./components/view.jsx";
import { createDecoder } from "./lib/decode.js";
import { snoop } from "./probes/probe.js";

const args = (typeof yeet !== "undefined" && yeet.args) || {};

const BIN = String(args.bin ?? args.b ?? "libssl.so");
const PID = args.pid != null ? Number(args.pid) : undefined;
const SECS = Number(args.secs ?? args.s ?? 0); /* 0 = run until Ctrl-C */
const FULL = parseBool(args.full); /* don't truncate payloads */
const MAXLEN = FULL ? Infinity : Number(args.maxlen ?? 1500);
const DEBUG = parseBool(args.debug ?? args.d); /* hexdump frame-stream starts */

function parseBool(v) {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "" || s === "1" || s === "true" || s === "yes" || s === "on";
}

/* ---- wire capture -> decode -> view --------------------------------- */

try {
  const view = createView({ bin: BIN, pid: PID, maxlen: MAXLEN });
  const decoder = createDecoder({ debug: DEBUG });

  const session = await snoop({
    bin: BIN,
    pid: PID,
    onEvent: (e) => {
      /* Keep decode/render faults local to the offending event. */
      try {
        for (const ev of decoder.push(e)) view.push(ev);
      } catch (err) {
        view.decodeError(err);
      }
    },
    onError: (err) => view.ringbufError(err),
  });

  /* The mounted UI keeps the isolate alive; q / Ctrl-C tears it down.
   * `--secs N` runs headless-ish for N seconds, then stops cleanly. */
  if (SECS > 0) {
    await new Promise((r) => setTimeout(r, SECS * 1000));
    await session.stop();
    view.stop();
  }
} catch (err) {
  console.error(err);
}
