# wssnoop

Decode the WebSocket traffic riding inside a process's **TLS** connections,
by tapping the plaintext at the OpenSSL boundary with eBPF. Built to test
against the demo in [`demo/`](./demo), but works on any OpenSSL-linked
process (Node, Python, curl, …).

Exchange / Polymarket WebSockets are `wss://` — TLS-encrypted — so a
packet-level tap only sees ciphertext. wssnoop instead uprobes
`SSL_write` / `SSL_read`, where the data is still (or already) plaintext,
and reassembles the WebSocket frames in JS.

## How it works

```
SSL_write(ssl, buf, num)   uprobe        plaintext in buf at entry   (egress, masked)
SSL_read(ssl, buf, num)    uprobe+uret   buf filled by return, len=ret (ingress, unmasked)
        │
   ringbuf  ── { ssl-ptr, pid, tid, dir, len, data } ──▶  capture (probes/probe.js)
                                                            │
                              reassemble per (pid, ssl, dir)   (lib/decode.js)
                              → HTTP upgrade handshake (notes permessage-deflate)
                              → RFC-6455 frames: unmask, de-fragment, JSON-decode
                                                            │
                                          live terminal log  (components/view.jsx)
```

The `SSL*` pointer is shipped as an opaque connection id; JS demuxes
streams by `(pid, ssl, direction)`. No parsing happens in the kernel.

## Layout

Generated from [`../script-template`](../script-template), in its source
layout — the three orthogonal halves are one module each. Internal imports
are **relative** (not the template's bundle-time `@/` alias) so the source
runs directly without a build step — `yeet run src/main.jsx` — for a tight
iteration loop; `make` still bundles it to `src/index.jsx` for shipping.

```
src/bpf/wssnoop.bpf.c   the tap: SSL_read/SSL_write uprobes → ringbuf
src/probes/probe.js     capture: owns the BPF lifecycle, streams raw chunks up
src/lib/decode.js       data: chunks → handshake + RFC-6455 frames → messages
src/lib/buffer.js       a signal of a sliding window over the last N pushes
                        (a circular buffer; the rolling log is built on it)
src/state.js            bind: runs capture → decode as the producer of reactive
                        signals (a bounded log + cumulative stats)
src/components/         present: pure UI reading those signals — root (the app
                        shell), header, footer, row (decoded event → log line)
src/main.jsx            the seam: parse args, build the session, mount the view
```

`probes/` is the only BPF-aware code; `lib/decode.js` is pure data (no
terminal, no I/O); `state.js` aggregates the decode stream into `from()`
signals whose lifecycle is tied to the view being mounted; `components/` never
see BPF or bytes, only signals. The same pipeline could drive a
capture-to-disk or a test as easily as the TUI.

## Build

Per the repo's VM workflow (macOS host → Lima VM):

```sh
cd wssnoop
make            # clang + bpftool → bin/probe.bpf.o; esbuild → src/index.jsx
                # (generates src/bpf/include/vmlinux.h from kernel BTF)
```

## Run

```sh
yeet run . -- --pid <pid> --bin <ssl-binary> [--full] [--secs N]
```

The UI is a live, scrolling log (built on `yeet:tui`) — newest event at the
bottom, header showing the tap and running counts. Press `q` or `Ctrl-C` to
quit.

`--bin` is **where the `SSL_*` symbols live**:

- **`libssl.so`** (the default) — when the target links OpenSSL
  dynamically. Debian/Ubuntu `apt` node does this.
- **an absolute path to a statically-linked executable** (e.g.
  `/usr/bin/node` from the official tarball / nodesource) — OpenSSL is
  baked into the binary, so probe the binary itself.

Find the right target for a running process:

```sh
readlink /proc/<pid>/exe          # the executable
ldd "$(readlink /proc/<pid>/exe)" | grep -i ssl   # shared libssl? → use that path
```

Flags: `--pid` scope to one process (recommended — otherwise every process
mapping `--bin` is traced); `--full` don't truncate payloads; `--maxlen N`
truncation cap (default 1500); `--secs N` run for N seconds then exit
(default: until you quit).

## Verified working (against the `demo/`, Node 24 static OpenSSL)

- Attaches to a static-OpenSSL Node binary by symbol, captures plaintext
  from **both** directions of **multiple concurrent** TLS WebSockets on one
  pid, demuxed by the `SSL*` pointer.
- **Masking** — client→server frames are unmasked correctly (verified on the
  egress `PING` keepalive).
- **Handshake + compression detection** — distinguishes plain HTTPS (REST,
  ignored), a Polymarket WS (`101`, no compression → clean JSON), and a
  Coinbase WS (`101` with `permessage-deflate` → flagged).
- Decodes a full message cleanly: e.g. a 13.5 KB Polymarket order-book
  `book` event parsed straight to JSON.
- `--debug` hexdumps the frame-stream head — handy for diagnosing the below.

## Known limits (it's a starting point, not a finished tool)

- **Multi-message bursts can desync.** The first frame of a burst decodes
  cleanly; a later large frame in the same burst can lose alignment (the
  parser then reads payload bytes as frame headers). Single-message cadence
  (price_change/trade updates, the first book) is solid. Root-cause still
  open — `--debug` shows the frame headers to chase it.
- **No `permessage-deflate` inflate.** When negotiated (Coinbase does;
  Polymarket does not — wssnoop flags it), text payloads arrive
  deflate-compressed and are shown raw. Inflating needs a zlib path the
  runtime doesn't expose yet.
- **Egress duplicates.** `SSL_write` is captured at entry, so non-blocking
  `WANT_WRITE` retries surface the same frame 2–3× (visible on the upgrade
  request / subscribe). Fix: capture `SSL_write` at return (like `SSL_read`)
  and key on the byte count actually written.
- **16 KB capture cap per SSL call** (`CHUNK` in `src/bpf/wssnoop.bpf.c`).
  One TLS record maxes near this, but a coalesced read larger than it
  truncates; wssnoop reports it and drops that connection rather than emit
  garbage.
- **Mid-stream attach desyncs** until the connection reconnects — a fresh
  handshake resets the stream (handled; OpenSSL reuses `SSL*` addresses).
- **Symbols:** hooks `SSL_read`/`SSL_write` only — not `SSL_read_ex` /
  `SSL_write_ex`. Stripped static binaries may not export `SSL_*`; use the
  `offset:` attach option.
