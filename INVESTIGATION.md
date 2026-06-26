# Crash postmortem — "the tty closes (crashes) after <1 min"

**Resolved.** The V8 worker died under live traffic; the daemon logged
`watchdog] V8 worker died. Respawning worker` with no JS exception (a hard
process death, not a catchable error), and the TTY closed with no message.

## Root cause: per-event memory pressure, not the uretprobe

An earlier pass *mis-attributed* the death to the `SSL_read` uretprobe, because
an egress-only build (no read probes) survived while a full build crashed. That
comparison was confounded: the egress object was freshly built at the reduced
capture size while the full object was the **old 16 KB-per-event build**. The
real driver was allocation churn — every ringbuf event decodes a whole
`ssl_event` struct into a JS object, and the per-frame sparklines were
allocating a fresh `Text`/`Run` tree on every heartbeat.

## The fix (all in this session)

- **`CHUNK` 16384 → 4096** in `wssnoop.bpf.c` — 4× smaller per-event struct, the
  dominant per-event allocation. Larger SSL calls report `truncated` (the conn
  is marked) instead of being captured whole.
- **Sparklines render to a `CellBuffer`** (`components/sparkline.jsx`), not a
  per-cell `Text` tree — eliminates ~120 object allocations per sparkline per
  heartbeat, ×13 sparklines on screen.
- **O(1) circular message ring** (`state.js`) and **drop retained `json`** —
  parse JSON on demand in the inspector instead of holding it per message.
- **`decoder.drop(key)`** on connection eviction (`lib/decode.js`) — no
  per-connection reassembly buffers leaking after a conn closes.

## Verification

Full mode (both uprobes + the `SSL_read` uretprobe active), `RECYCLE=8000`
(reconnect every ~8 s — the exact churn the old build died on):

```
t+60s  jail=298248 rss=135 MB deaths=0
t+120s jail=298248 rss=182 MB deaths=0
t+180s jail=298248 rss=186 MB deaths=0
```

Same jail PID across 3 minutes (no respawn), zero worker deaths, RSS plateaus
well under the 384 MB heap limit. Unit suite: 70/70.

## What stays in place

- `state.js` heartbeat (`publish`) is wrapped in try/catch → a *catchable* fault
  degrades to a status line instead of taking the worker down.
- `main.jsx` wraps `mount()` → a setup throw shows a BSOD (`components/bsod.jsx`)
  instead of a raw stack.
- A *hard* worker death still can't be surfaced from JS (no global error hook in
  the runtime). It no longer happens under normal load; if it recurs, the daemon
  log is the place to look.

## Dropped: egress-only mode

An `-DEGRESS_ONLY` second object (`probe-egress.bpf.o`) was built as a
crash-workaround. With the crash fixed it was unnecessary, and it had its own
defect — it captured **0** `SSL_write` events (a single-program
`bpftool gen object` relocation issue; the full object captures egress fine).
Removed. The in-kernel **focus filter** (target one `SSL*`/pid, mute the rest
before the ringbuf reserve) already covers the "zero overhead for everything
else" story.
