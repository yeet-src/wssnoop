# wssnoop

A live inspector for the WebSocket traffic riding inside a process's **TLS**
connections — tapped as plaintext at the OpenSSL boundary with eBPF, decoded
and presented as a reactive terminal UI.

`wss://` is TLS-encrypted, so a packet tap sees only ciphertext. wssnoop
uprobes `SSL_write` / `SSL_read`, where the bytes are still (or already)
plaintext, reassembles the RFC-6455 frames in JS (inflating
`permessage-deflate`), and shows them grouped by process and connection.

Built for inspecting exchange / prediction-market sockets (Polymarket,
Coinbase, …), but works on any OpenSSL-linked process (Node, Python, curl, …).

## What it does

- **Grouped table** — one section per process (`comm` / cmdline resolved via the
  system graph, plus a container tag), each streaming its WebSocket connections
  as rows: role (client/server, inferred from the handshake direction),
  destination `wss://` URL, message ↑/↓ counts, and a two-tone activity
  sparkline (upper half = egress, lower = ingress; brightness = bytes/sec).
- **Drill-down inspector** — click a connection for a docked panel over the
  dimmed table: live message log (newest first), click a message to pause and
  expand its payload as **syntax-highlighted JSON**, text, or a hex dump
  (toggle raw bytes even when decoded). Compressed messages are shown
  **decompressed**, with a `⚙` badge and per-message compression ratio.
- **All the metadata, discoverable** — an `⊕ details` expansion surfaces
  deflate params, subprotocol, extensions, origin, opcode histogram, and close
  code/reason; each expanded message shows frame health (fragmentation, masking
  correctness, wire vs inflated size).
- **Capture for fixtures** — `⧉ copy all` / `⧉ copy msg` write the messages as
  JSON Lines to the system clipboard (OSC52, works over SSH/VM) — drop straight
  into a test suite. Filtering narrows what's copied.
- **Search / filter** — `/` opens a free-text query (messages while inspecting,
  connections otherwise); plus role and active-only filters and column sort.
- **Act on the kernel** — `⊙ focus` writes the BPF capture filter live so the
  probe emits only the focused connection's events; every other one goes silent
  *in the kernel*, at near-zero overhead. A real user→kernel write, not just a
  read.

## How it works

```
SSL_write(ssl, buf, num)  uprobe       plaintext in buf at entry    (egress, masked)
SSL_read(ssl, buf, num)   uprobe+uret  buf filled by return, len=ret (ingress, unmasked)
        │
   ringbuf ── { ssl-ptr, pid, tid, dir, len, data } ──▶  capture (probes/probe.js)
                                                           │
                              reassemble per (pid, ssl, dir)   (lib/decode.js)
                              → HTTP upgrade handshake (permessage-deflate params)
                              → RFC-6455 frames: unmask, de-fragment, inflate, JSON
                                                           │
                              registry of connections-over-time (state.js)
                                                           │
                              reactive signals → grouped table + inspector (components/)
```

The `SSL*` pointer is the opaque connection id; JS demuxes streams by
`(pid, ssl, direction)`. No parsing happens in the kernel — only the capture
(and the live `focus` filter) live there.

## Layout

Source layout — internal imports are **relative** so it runs directly without a
build step (`yeet run src/main.jsx`) for a tight loop.

```
src/bpf/wssnoop.bpf.c   the tap: SSL_read/SSL_write uprobes → ringbuf; a live
                        capture-filter (focus ssl/pid) written from JS
src/probes/probe.js     capture: BPF lifecycle, raw chunks up, focus filter down
src/probes/procinfo.js  process identity (comm/cmdline/exe/container) via the graph
src/lib/decode.js       data: chunks → handshake + RFC-6455 frames → messages
src/lib/timehist.js     data: a time-bucketed up/down byte ring per stream
src/lib/{format,rank,export}.js  pure helpers: formatting + JSON highlight, sort
                        metrics, JSONL/base64 export
src/state.js            bind: decode → a registry of connections-over-time,
                        published as reactive snapshot signals
src/controls.js         view state: sort / filter / search / collapse / focus
src/components/         present: pure UI reading signals (root, toolbar, group,
                        row, inspector, sparkline, searchbar, minibuffer, button)
src/main.jsx            the seam: parse args, build the session, mount the view
```

`probes/` is the only BPF/graph-aware code; `lib/decode.js` is pure data;
`components/` see only signals. The same pipeline could drive a capture-to-disk
or a test as easily as the TUI (see `test/lib.test.js`).

## Build

The BPF object is built with a vendored clang/bpftool toolchain (no system C
toolchain needed):

```sh
cd wssnoop
make bpf         # clang + bpftool → bin/probe.bpf.o (+ vmlinux.h from kernel BTF)
```

`yeet run src/main.jsx` runs straight from source — no JS bundle step.

## Run (the demo)

One command brings up traffic and the UI, with no browser:

```sh
./demo/run.sh --attach     # 3 worker processes × (coinbase+kraken+polymarket),
                           # then wssnoop attached to all of them
./demo/run.sh              # just the traffic; prints the attach command
./demo/run.sh --stop       # stop the workers
```

The workers (`demo/worker.mjs`) run as distinct processes (`order-router`,
`md-gateway`, `risk-engine`), each holding several live `wss://` connections and
continuously churning subscriptions, so there's rich multi-process,
multi-connection, bidirectional traffic immediately.

### Attaching to your own process

```sh
yeet run src/main.jsx -- --pid <pid> --bin <ssl-binary> [--secs N]
```

`--bin` is **where the `SSL_*` symbols live**:

- a shared **`libssl.so`** when the target links OpenSSL dynamically, or
- an **absolute path to a statically-linked executable** (e.g. nvm/official
  Node bakes OpenSSL in — probe the `node` binary itself).

```sh
readlink /proc/<pid>/exe                            # the executable
ldd "$(readlink /proc/<pid>/exe)" | grep -i ssl     # shared libssl? use that
```

With no `--pid`, every process mapping `--bin` is traced (this is how the demo
sees all three workers at once) — but note a `--bin`-only attach hooks the
processes that exist *at attach time*, so start the targets first.

Keys: `/` search, `q` / `Ctrl-C` quit, `Esc` backs out (clear filter → close
inspector → quit). Everything else is mouse-driven; hover any control for help
in the minibuffer.

## Notes / limits

- **Mid-stream attach** shows `?` for role/dest until the connection reconnects
  with a fresh handshake (OpenSSL reuses `SSL*` addresses; a new handshake
  resets the stream). The demo workers recycle connections so this self-heals.
- **16 KB capture cap per SSL call** (`CHUNK` in `wssnoop.bpf.c`). One TLS
  record maxes near this; a larger coalesced read is reported as truncated
  rather than emitting garbage.
- Hooks `SSL_read` / `SSL_write` (not the `_ex` variants). Stripped static
  binaries may need the `offset:` attach option.
- Export goes to the system clipboard via OSC52 — large captures may hit your
  terminal's clipboard size cap.
