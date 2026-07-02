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
 * Run:
 *   yeet run src/main.jsx                    # no args: browse & pick a process
 *   yeet run src/main.jsx -- --pid <pid>     # arm one process straight away
 *   yeet run src/main.jsx -- --bin <binary>  # bin-wide (every process using it)
 *
 * With no args nothing is tapped: the connection browser (layer-1 discovery,
 * near-zero cost) opens on the host-wide list of outbound connections, and you
 * click a process to attach a pid-scoped SSL tap to it. Reopen it any time with
 * `c`. --pid arms one process up front; each armed process gets its own tap
 * scoped to that pid, so bystanders pay nothing.
 * --bin is where the SSL_read/SSL_write symbols live: a shared OpenSSL
 *   (`libssl.so`) OR an absolute path to a statically-linked executable. It
 *   attaches bin-wide (the one broad-overhead path). Omit it and each armed pid
 *   discovers its own SSL binary from the process graph (probes/discover.js). */

import { mount } from "yeet:tui";

import Root from "./components/root.jsx";
import Bsod from "./components/bsod.jsx";
import { createSession } from "./state.js";
import {
  isInspecting,
  closeInspector,
  search,
  searchActive,
  startSearch,
  stopSearch,
  clearSearch,
  typeSearch,
  backspaceSearch,
  keymap,
  cursorPinned,
  clearCursor,
  helpOpen,
  toggleHelp,
  closeHelp,
  arm,
  browserOpen,
  openBrowser,
  closeBrowser,
  toggleBrowser,
  isBrowsing,
} from "./controls.js";

const args = (typeof yeet !== "undefined" && yeet.args) || {};

const binArg = args.bin ?? args.b;
const BIN = binArg != null ? String(binArg) : undefined; /* undefined ⇒ auto-discover */
const PID = args.pid != null ? Number(args.pid) : undefined;
/* test-only: exit after N seconds (clean teardown). Named verbosely so it's
 * never mistaken for a normal run option — the UI otherwise runs until quit. */
const SECS = Number(args["testonly-exit-after-secs"] ?? 0); /* 0 = run until quit */
const DEBUG = parseBool(args.debug ?? args.d);

function parseBool(v) {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "" || s === "1" || s === "true" || s === "yes" || s === "on";
}

tty.enableMouse(); /* hover tooltips + clickable controls */
tty.on("keydown", (e) => {
  const key = e.key ?? "";

  /* Search text-entry mode: keys feed the query box, not commands. */
  if (searchActive.get()) {
    if (e.code === "Escape") return clearSearch(); // cancel + clear the filter
    if (e.code === "Enter") return stopSearch(); // confirm; query stays a live filter
    if (e.code === "Backspace") return backspaceSearch();
    if (key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault?.();
      return typeSearch(key);
    }
    return;
  }

  /* Command mode. Esc progressively backs out: clear filter → close inspector
   * → quit. "/" opens search. q quits. */
  if (key === "?") {
    e.preventDefault?.();
    return toggleHelp();
  }
  if (key === "/") {
    e.preventDefault?.();
    return startSearch();
  }
  /* `c` toggles the connection browser (layer-1 discovery) — pick which
   * processes to decode. Not while inspecting a message log. */
  if (key.toLowerCase() === "c" && !isInspecting()) {
    e.preventDefault?.();
    return toggleBrowser();
  }
  if (e.code === "Escape") {
    if (helpOpen.get()) return closeHelp();
    if (browserOpen.get()) return closeBrowser();
    if (search.get()) return clearSearch();
    if (cursorPinned.get()) return clearCursor();
    if (isInspecting()) return closeInspector();
    return yeet.exit();
  }
  if (key.toLowerCase() === "q") return yeet.exit();

  /* Global-action shortcuts (sort/role/idle/rows/window) — the same actions the
   * toolbar buttons run, each discoverable via the button's mouseover. Gated to
   * the table view so they don't fire behind an overlay. */
  const action = keymap[key];
  if (action && !isInspecting() && !helpOpen.get() && !isBrowsing()) {
    e.preventDefault?.();
    action();
  }
});

/* Decide the initial capture target from the args:
 *   --pid N   → arm that process (a pid-scoped tap; bystanders pay nothing).
 *   --bin X   → a bin-wide tap (traps every process using X — the one broad-
 *               overhead path, opted into explicitly).
 *   neither   → nothing tapped; open the browser to pick a process from the
 *               live host-wide connection list (layer-1, near-zero cost).
 * The browser is always reopenable with `c`. */
if (PID != null) arm(PID);
const BIN_WIDE = PID == null && BIN != null ? BIN : null;
if (PID == null && BIN == null) openBrowser();

/* The session is a bundle of signals; the BPF taps attach when the view mounts
 * (the signals get watched), reconcile against the armed set, and detach when
 * it unmounts. */
const session = createSession({ binWide: BIN_WIDE, debug: DEBUG });
let teardown;
try {
  teardown = mount((size) => <Root size={size} {...session} />);
} catch (e) {
  teardown = mount(() => <Bsod error={e} />); // setup threw → show it, don't dump a stack
}

/* `--testonly-exit-after-secs N` runs for N seconds, then unmounts (tearing the
 * tap down) and exits; otherwise the mounted UI keeps the isolate alive until
 * q / Ctrl-C. For the headless demo/test harness only. */
if (SECS > 0) {
  await new Promise((r) => setTimeout(r, SECS * 1000));
  teardown();
  yeet.exit();
}
await new Promise(() => {}); // keep the script alive; the TUI owns the screen
