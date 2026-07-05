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
  system graph), each streaming its WebSocket connections as rows; processes
  that run in a container nest under a **container header** (⬢ name + image,
  resolved via the graph's `docker` field) with their own aggregate sparkline.
  Each connection row shows role (client/server, inferred from the handshake
  direction),
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
./demo/run.sh attach     # 3 worker processes × (coinbase+kraken+polymarket),
                         # then wssnoop attached to all of them
./demo/run.sh start      # just the traffic; prints the attach command
./demo/run.sh docker     # run the workers INSIDE a docker container and attach —
                         # shows the container nesting tier (needs docker)
./demo/run.sh status     # which workers are running
./demo/run.sh stop       # stop the workers (and the demo container)
./demo/run.sh            # (or `help`) usage
```

The workers (`demo/worker.mjs`) run as distinct processes (`order-router`,
`md-gateway`, `risk-engine`), each holding several live `wss://` connections and
continuously churning subscriptions, so there's rich multi-process,
multi-connection, bidirectional traffic immediately. `docker` instead runs two
workers inside one container, so the table shows them nested under their
container (⬢) — wssnoop attaches to the container's own `node` binary (reached
from the host via `/proc/<pid>/root/...`, since Node statically links its TLS).

### Attaching to your own process

```sh
yeet run src/main.jsx -- --pid <pid> [--bin <ssl-binary>]
```

`--bin` is **where the `SSL_*` symbols live**:

- a shared **`libssl.so`** when the target links OpenSSL dynamically, or
- an **absolute path to a statically-linked executable** (e.g. nvm/official
  Node bakes OpenSSL in — probe the `node` binary itself).

`--bin` is **optional** — omit it and wssnoop discovers the target from the
process graph: a bare program name (`--bin node`) resolves to that program's
exe, and `--pid N` alone finds that process's mapped `libssl` (or its exe for
static SSL). A `--pid` inside a **container** works too: the binary is resolved
through the process's mount namespace (`/proc/<pid>/root/...`), so the container's
own `node`/`libssl` is attachable from the host. Pass an explicit path/library
to override. To resolve by hand:

```sh
readlink /proc/<pid>/exe                            # the executable
ldd "$(readlink /proc/<pid>/exe)" | grep -i ssl     # shared libssl? use that
```

`--pid` takes one pid or several (`--pid a,b,c`) — the demo arms every worker
this way, so all four runtimes decode at once. With no `--pid`, every process
mapping `--bin` is traced instead — but a `--bin`-only attach hooks the
processes that exist *at attach time*, so start the targets first.

Keys: `/` search · `s` sort · `r` role · `i` idle rows · `a` rows-per-process ·
`m` aggregate metric (bandwidth/messages) · `[` / `]` activity window · `q` /
`Ctrl-C` quit · `Esc` backs out (clear filter
→ close inspector → quit). Everything else is mouse-driven; hover any control
for help (and its shortcut) in the minibuffer.

## Notes / limits

- **Mid-stream attach** shows `?` for role/dest until the connection reconnects
  with a fresh handshake (OpenSSL reuses `SSL*` addresses; a new handshake
  resets the stream). The demo workers recycle connections so this self-heals.
- **4 KB capture cap per SSL call** (`CHUNK` in `wssnoop.bpf.c`). One TLS
  record maxes near this; a larger coalesced read is reported as truncated
  rather than emitting garbage.
- Export goes to the system clipboard via OSC52 — large captures may hit your
  terminal's clipboard size cap.

### TLS runtime coverage

wssnoop attaches whichever plaintext boundaries a process offers, best-effort:

| Runtime | Boundary hooked |
|---|---|
| OpenSSL (Node, Python, Ruby, Rust native-tls, C/C++ …) | `SSL_read`/`SSL_write` **and** `SSL_read_ex`/`SSL_write_ex` (CPython uses the `_ex` pair) — in a mapped `libssl` or baked static into the exe |
| Go (gorilla, net/http, anything on the stdlib) | `crypto/tls.(*Conn).Read`/`Write` (register ABI; reads goroutine-id-keyed) |
| rustls (tokio-tungstenite, any pure-Rust TLS) | `ConnectionCommon::…PlaintextSink::write` + `CommonState::take_received_plaintext`, resolved by `symbol_prefix` (the mangled hash varies per build) |

A process on a stack with none of these (a stripped static build, or a TLS lib
we don't hook) shows up but decodes to nothing — it's marked **opaque** rather
than hidden.

### Production / stripped binaries

What survives depends on the strip level, and it differs by runtime:

- **Dynamically-linked OpenSSL is immune.** `SSL_*` live in `libssl`'s
  `.dynsym`, which `strip` never removes — so Python `websockets`, dynamically
  linked Rust native-tls / C++ keep decoding no matter how the *app* is built.
- **Go, rustls, static-OpenSSL** put their symbols in `.symtab`, which a **full
  strip removes** (`strip`, cargo `strip = true`, `go build -ldflags="-s -w"`) —
  then the name/prefix attach can't resolve them. Not stripped → symbols are
  just *mangled*, which the exact/`symbol_prefix` matching handles.
- **For rustls, use `strip = "debuginfo"`** (not `strip = true`) in
  `[profile.release]`: it drops DWARF (most of the size) but **keeps `.symtab`**,
  so hooks still resolve. Same idea for C++: keep the symbol table, or ship a
  separate debug file.
- **Stripped Go stays recoverable in principle**: `-s -w` wipes `.symtab` but
  the `.gopclntab` function table remains (the runtime needs it), so a
  gopclntab-aware resolver can still find the functions — planned, not yet
  wired.
