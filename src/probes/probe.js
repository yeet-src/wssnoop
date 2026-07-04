/* wssnoop/probe — the capture half: attach the BPF program at the OpenSSL
 * boundary and stream raw `ssl_event` records up from the ringbuf. The only
 * BPF-aware module: it owns the whole BPF lifecycle (load, bind, attach,
 * subscribe, teardown) and knows nothing about what the bytes mean — that's
 * lib/decode.js's job. */

import { BpfObject, RingBuf, ArrayMap } from "yeet:bpf";

import { resolveBin } from "./discover.js";

// bin/probe.bpf.o sits at the project root (src/bpf/wssnoop.bpf.c links into
// it — see build/bpf.mk). `base: import.meta.dirname` anchors the lookup on
// this module's directory, which differs by one level between the two ways
// the project runs: bundled, everything is flattened into src/index.jsx
// (dirname = src/, so ../bin); run straight from source for a faster loop
// (`yeet run src/main.jsx`), this file stays at src/probes/ (dirname one
// deeper, so ../../bin). Detect the bundle by its entry filename.
const inBundle = import.meta.filename.endsWith("/index.jsx");
const BIN_DIR = inBundle ? "../bin" : "../../bin";

/* Attach the SSL_write and SSL_read uprobes in `bin` (scoped to `pid` when
 * given), delivering each plaintext chunk to onEvent(rawEvent) and any
 * transport fault to onError(err). Returns a session whose stop() detaches.
 *
 *   const session = await snoop({ bin, pid, onEvent, onError });
 */
/* The plaintext boundaries we know how to hook, one loadable object each. A
 * target offers some subset — an OpenSSL app has CLASSIC (+EX on OpenSSL 3), a
 * Go app has GO, a BoringSSL app has only CLASSIC — so every object is attached
 * BEST-EFFORT and independently: start() rejects an object with any unattached
 * uprobe, so one object's missing symbols must not take down another's. snoop()
 * keeps whichever bind; if none do (rustls, a stripped static exe), the caller
 * falls back to the plaintext socket tap. */

/* Classic byte-count OpenSSL (SSL_read/SSL_write) — node, Rust native-tls, uSockets. */
const CLASSIC = {
  file: "probe.bpf.o",
  probes: [
    ["probe_ssl_write", "SSL_write"],
    ["probe_ssl_read_enter", "SSL_read"],
    ["probe_ssl_read_exit", "SSL_read"],
  ],
};

/* OpenSSL 1.1.1+ `_ex` API — what CPython (and so Python `websockets`) calls;
 * absent from BoringSSL / pre-1.1.1 OpenSSL. */
const EX = {
  file: "probe_ex.bpf.o",
  probes: [
    ["probe_ssl_write_ex", "SSL_write_ex"],
    ["probe_ssl_read_ex_enter", "SSL_read_ex"],
    ["probe_ssl_read_ex_exit", "SSL_read_ex"],
  ],
};

/* Go's crypto/tls (no OpenSSL symbols at all). The symbol names carry the Go
 * package path; libbpf resolves them from .symtab, so a stripped Go binary
 * won't attach. Both directions of crypto/tls.(*Conn).Write/Read; the read pair
 * is goid-keyed (goroutines migrate threads mid-call) — see goprobe.bpf.c. */
const GO = {
  file: "goprobe.bpf.o",
  probes: [
    ["probe_go_tls_write", "crypto/tls.(*Conn).Write"],
    ["probe_go_tls_read_enter", "crypto/tls.(*Conn).Read"],
    ["probe_go_tls_read_exit", "crypto/tls.(*Conn).Read"],
  ],
};

/* rustls (tokio-tungstenite, any pure-Rust TLS). Its boundary symbols are
 * mangled with a per-build codegen hash the isolate can't know, so we attach by
 * `symbol_prefix`: the daemon resolves the single .symtab/.dynsym symbol
 * starting with the stable prefix (the part before the `17h<hash>E` suffix) and
 * errors if none/several match. So this needs no per-binary config — a
 * non-rustls target simply has no such symbol and the attach is skipped. The
 * prefixes are legacy-mangling specific (rustc's `_ZN…`); a v0-mangled build
 * would need the `_R…` forms. Egress `…PlaintextSink$GT$5write17h` stops at
 * `5write` so it can't also match `14write_vectored`. */
const RUST_WRITE_PREFIX =
  "_ZN99_$LT$rustls..conn..ConnectionCommon$LT$T$GT$$u20$as$u20$rustls..conn..connection..PlaintextSink$GT$5write17h";
const RUST_READ_PREFIX = "_ZN6rustls12common_state11CommonState23take_received_plaintext17h";
const RUST = {
  file: "rustprobe.bpf.o",
  probes: [
    ["probe_rust_tls_write", { symbol_prefix: RUST_WRITE_PREFIX }],
    ["probe_rust_tls_read", { symbol_prefix: RUST_READ_PREFIX }],
  ],
};

export async function snoop({ bin, pid, onEvent, onError, onBin }) {
  /* Discover where the SSL symbols live (path / library / process exe) before
   * attaching; report the resolved target so the UI can show what it hooked. */
  const target = await resolveBin({ bin, pid });
  onBin?.(target);

  // Attaches as `kind: "uprobe"`; the daemon reads each program's ELF section
  // to tell entry (SEC("uprobe")) from return (SEC("uretprobe")).
  const uprobe = { kind: "uprobe", binary: target, pid };

  /* Load one tap object, attach its uprobes, and wire its ringbuf → onEvent and
   * its live focus filter. Throws if a symbol can't be attached (the caller
   * decides whether that's fatal or best-effort). */
  const attachTap = async ({ file, probes }) => {
    let obj = new BpfObject({ exe: `${BIN_DIR}/${file}`, base: import.meta.dirname })
      .bind("events", { kind: "ringbuf", btf_struct: "ssl_event" })
      .bind("focus", { kind: "array" }); // writable filter (slot 0 ssl, 1 pid)
    // A probe's target is either an exact symbol (string) or attach options
    // (e.g. { symbol_prefix }) merged into the uprobe spec.
    for (const [prog, target] of probes) {
      const opts = typeof target === "string" ? { symbol: target } : target;
      obj = obj.attach(prog, { ...uprobe, ...opts });
    }
    const control = await obj.start();

    const focus = new ArrayMap(control, "focus");
    const setFocus = async ({ ssl = 0n, pid = 0 } = {}) => {
      try {
        await focus.update(0, BigInt(ssl || 0));
        await focus.update(1, BigInt(pid || 0));
      } catch (err) {
        if (onError) onError(err);
      }
    };

    const sub = await new RingBuf(control, "events").subscribe(
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
  };

  /* Attach every boundary we can; a target offers some subset. If none bind,
   * throw so the caller falls back to the plaintext socket tap. */
  const taps = [];
  for (const spec of [CLASSIC, EX, GO, RUST]) {
    try {
      taps.push(await attachTap(spec));
    } catch {
      /* this boundary's symbols aren't in the target — try the next */
    }
  }
  if (taps.length === 0) throw new Error("no tappable TLS boundary");

  return {
    setFocus: async (f) => {
      for (const t of taps) await t.setFocus(f);
    },
    async stop() {
      for (const t of taps) await t.stop();
    },
  };
}
