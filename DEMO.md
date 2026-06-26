# wssnoop — demo script

A ~3-minute run for prediction-market infra engineers. The thesis: **see, decode,
capture, and act on the WebSocket traffic your nodes can't otherwise observe —
all from the encrypted side, with eBPF.**

## Setup (once, in the yeet VM)

```sh
cd ~/src/yeet/wssnoop
make bpf                 # build the probe object (if not already built)
./demo/run.sh attach   # 3 worker processes, live traffic, wssnoop attached
```

That's it — the screen fills with three processes (`order-router`, `md-gateway`,
`risk-engine`), each holding live Coinbase / Kraken / Polymarket connections.

## The run

1. **"This is every WebSocket our nodes are running, decrypted."**
   Point at the grouped table: processes by identity (not just pid), each
   connection's role (`client`), destination `wss://` URL, message ↑/↓ counts,
   and the two-tone sparkline — **upper half = egress, lower = ingress**
   (the egress story they care about). A global activity bar up top.

2. **Drill in — click any connection.**
   The inspector opens: a live message log. **Click a message** → it expands to
   pretty, syntax-highlighted JSON. Note the `⚙` badge and "wire 258B · 1.5×":
   **these arrived permessage-deflate compressed and we decoded them** — the
   thing a packet capture can't do.

3. **All the metadata, on demand — click `⊕ details`.**
   Subprotocol, negotiated extensions, deflate window, opcode histogram, close
   codes. Expand a message to see frame health (fragmentation, masking, sizes).

4. **Capture for fixtures — click `⧉ copy all`.**
   It's now JSON Lines on your clipboard — every message, both directions,
   decoded. Paste it into a terminal/editor:
   *"That's a test fixture from real production traffic, in one click."*
   (Type `/` and a product, e.g. `/BTC`, first to capture only matching messages.)

5. **Act on the kernel — click `⊙ focus`.**
   Every other connection's sparkline flatlines. *"We just wrote a filter into
   the running eBPF program — the probe now emits only this connection's events.
   On a busy production node you capture exactly what you want at near-zero
   overhead."* This is the "not just reading — writing to the kernel" beat.
   Click the `⊙ focused ✕` chip (top bar) to release.

6. **Search** — `/` filters messages while inspecting, connections otherwise.

Quit with `q`. (`Esc` backs out: clear filter → close inspector → quit.)

## If something looks stuck

- **Rows show `?` for role/dest**: a mid-stream attach (connection opened before
  wssnoop). It self-heals as connections recycle; or just `q` and re-run
  `./demo/run.sh attach` (it starts the workers first so handshakes are caught).
- **"probe failed" / hangs on attach**: the daemon got into a bad state (usually
  from a hard kill leaking a BPF attach). Restart it and retry:
  ```sh
  sudo pkill -9 -x yeetd
  cd /opt/yeet && setsid sudo ./crates/target/release/yeetd >/tmp/yeetd.log 2>&1 </dev/null &
  ```
  Always quit wssnoop with `q` (graceful) rather than closing the terminal.
