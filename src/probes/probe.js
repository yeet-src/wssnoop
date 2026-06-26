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
const probe = new BpfObject({
  exe: inBundle ? "../bin/probe.bpf.o" : "../../bin/probe.bpf.o",
  base: import.meta.dirname,
});

/* Attach the SSL_read/SSL_write uprobes in `bin` (scoped to `pid` when
 * given), delivering each plaintext chunk to onEvent(rawEvent) and any
 * transport fault to onError(err). Returns a session whose stop() detaches.
 *
 *   const session = await snoop({ bin, pid, onEvent, onError });
 *   ...
 *   await session.stop();
 */
export async function snoop({ bin, pid, onEvent, onError }) {
  // All three attach as `kind: "uprobe"`; the daemon reads each program's ELF
  // section to tell entry (SEC("uprobe")) from return (SEC("uretprobe")).
  const uprobe = { kind: "uprobe", binary: bin, pid };

  const control = await probe
    .bind("events", { kind: "ringbuf", btf_struct: "ssl_event" })
    .bind("focus", { kind: "array" }) // writable capture-filter (slot 0 ssl, 1 pid)
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
