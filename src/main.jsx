/* wssnoop — decode the WebSocket traffic riding inside a process's TLS
 * connections, by tapping the plaintext at the OpenSSL boundary, and present it
 * as a live *grouped table*: one section per process, each streaming its recent
 * WebSocket connections as rows (role · destination · message counts · an
 * up/down activity sparkline), with process- and host-level aggregate
 * sparklines above. Everything is mouse-driven; hover a control for help.
 *
 *   probes/probe.js  — capture: owns the BPF lifecycle, streams raw chunks up.
 *   lib/decode.js    — data:    chunks → HTTP upgrade → RFC-6455 frames.
 *   lib/timehist.js  — data:    a time-bucketed up/down byte ring per stream.
 *   state.js         — bind:    decode → a registry of connections-over-time,
 *                               published as reactive snapshot signals.
 *   controls.js      — view state: sort / filter / collapse / viz range / hover.
 *   components/       — present: pure UI reading those signals.
 * This file is the seam: parse args, build the session, mount the view.
 *
 * Run (against the demo node server in the VM):
 *   yeet run src/main.jsx -- --pid <node-pid> --bin <ssl-binary>
 *
 * --bin is where the SSL_read/SSL_write symbols live: a shared OpenSSL
 *   (`libssl.so`, the default) OR an absolute path to a statically-linked
 *   executable. --pid scopes the probe to one process (recommended). */

import { mount } from "yeet:tui";

import Root from "./components/root.jsx";
import { createSession } from "./state.js";
import { isInspecting, closeInspector } from "./controls.js";

const args = (typeof yeet !== "undefined" && yeet.args) || {};

const BIN = String(args.bin ?? args.b ?? "libssl.so");
const PID = args.pid != null ? Number(args.pid) : undefined;
const SECS = Number(args.secs ?? args.s ?? 0); /* 0 = run until quit */
const DEBUG = parseBool(args.debug ?? args.d);

function parseBool(v) {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "" || s === "1" || s === "true" || s === "yes" || s === "on";
}

tty.enableMouse(); /* hover tooltips + clickable controls */
tty.on("keydown", (e) => {
  /* Escape backs out of the inspector first; only quits when nothing's open. */
  if (e.code === "Escape" && isInspecting()) return closeInspector();
  if (e.code === "Escape" || (e.key ?? "").toLowerCase() === "q") yeet.exit();
});

/* The session is a bundle of signals; the BPF tap attaches when the view mounts
 * (the signals get watched) and detaches when it unmounts. */
const session = createSession({ bin: BIN, pid: PID, debug: DEBUG });
const teardown = mount((size) => <Root size={size} {...session} />);

/* `--secs N` runs for N seconds, then unmounts (tearing the tap down) and exits;
 * otherwise the mounted UI keeps the isolate alive until q / Ctrl-C. */
if (SECS > 0) {
  await new Promise((r) => setTimeout(r, SECS * 1000));
  teardown();
  yeet.exit();
}
await new Promise(() => {}); // keep the script alive; the TUI owns the screen
