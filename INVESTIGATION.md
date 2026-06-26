# Crash investigation (the "tty closes <1min" bug)

Status as of this overnight session. The two paths to capturing traffic are
**both currently broken**, for reasons below wssnoop itself. Details so you can
pick up fast.

## 1. Full mode crashes the V8 worker (SSL_read uretprobe runtime defect)

**Confirmed with a minimal repro** — not the app, just the BPF object + a
ringbuf subscriber:

```
BpfObject(probe.bpf.o)
  .bind events + focus
  .attach probe_ssl_write / probe_ssl_read_enter / probe_ssl_read_exit
  .start(); subscribe(events)
```

With live ingress traffic this **dies within ~5–6s** — the daemon logs
`WARN yeetd::core::v8::manager::watchdog] V8 worker died. Respawning worker`
with **no JS exception** beforehand (so it's a hard process death — OOM / native
fault / watchdog kill — *not* a catchable error). The TTY then closes with no
message.

Findings:
- It is **the SSL_read uretprobe** (`probe_ssl_read_exit`). Egress-only (no
  uretprobe) never dies (ran 75s+ clean, 0 deaths).
- It is **not** reconnect-specific: it crashes under steady ingress with
  `--recycle 0` (no reconnects) and no Polymarket/gamma HTTPS, just
  coinbase+kraken tickers.
- Not OOM in the usual sense: the jail RSS was flat at ~136 MB right up to a
  death; conn count stabilises (~15), doesn't grow unboundedly.

**This is a yeet runtime defect**, not fixable in wssnoop JS. The minimal repro
above should hand the runtime team a clean reproduction. (`main.jsx` already
documents it and `--egress-only` is the intended workaround.)

What wssnoop now does about it (this session):
- `state.js` heartbeat (`publish`) is wrapped in try/catch → a *catchable*
  fault degrades to a status line instead of taking the worker down.
- `main.jsx` wraps `mount()` → setup throws show a BSOD (`components/bsod.jsx`)
  instead of a raw stack.
- A hard worker death still can't be shown from JS (no global error hook in the
  runtime — checked).

## 2. Egress-only is stable but captures **0** events (build defect)

`probe-egress.bpf.o` (the `-DEGRESS_ONLY` variant) **attaches cleanly** (status
reaches "tracing") but captures **0 SSL_write events** over 8–10s while workers
are actively sending (full mode captures egress fine — we've seen
subscribe/unsubscribe frames). Verified in isolation:

```
BpfObject(probe-egress.bpf.o).bind events+focus.attach probe_ssl_write.start()
subscribe(events) → 0 events in 8s, no error
```

The source is correct for egress (SSL_write → emit → ringbuf, all outside the
`#ifndef EGRESS_ONLY`), and a clean `make clean && make bpf` doesn't change it.
Suspect a `bpftool gen object` relocation issue in the single-program object
(e.g. `bpf_ringbuf_reserve(&events,…)` resolving to a bad map → returns null →
`emit` bails silently). Needs kernel-side confirmation (a `bpf_printk` in
`emit`, or comparing the two objects' map/reloc tables) — couldn't get that far
with the flaky tmux/daemon in this session.

## Net for the demo

- Neither mode currently gives a reliable *rich* (ingress) demo.
- If egress-only's capture is fixed, it's the reliable path **and** matches the
  prospect's stated #1 ("mainly egress … which subscriptions are active") — the
  subscribe/unsubscribe frames are exactly that.
- Everything else (UI, decode, inspector, export, search, focus, tests) is solid
  and verified; this is purely the capture-transport layer.

## Reproduce / debug quickly

```
# minimal crash repro (full mode): dies ~5s
# minimal egress 0-capture repro: see the two snippets above
./demo/run.sh                 # start workers (they send egress continuously)
make clean && make bpf        # rebuild both objects
```
