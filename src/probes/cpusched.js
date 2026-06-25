// BPF data layer — the only BPF-aware module. It loads the program,
// subscribes to the context-switch ring buffer, and exposes plain reactive
// signals; it also owns the runtime knob the UI patches into the kernel.
//
// Two directions of reactivity live here:
//   kernel -> user : `cpus` is built with from() over the ring buffer — the
//                    subscription's lifecycle is tied to the signal being
//                    watched, and a window timer turns events into per-CPU
//                    rates + a rolling feed.
//   user -> kernel : setMinSlice() patches the `min_slice_ns` global in the
//                    program's .data section, so the kernel re-filters live.
import { DataSec, RingBuf } from "yeet:bpf";
import { from, signal } from "yeet:tui";
import { _ } from "yeet:helpers";
import { control, numCpus } from "@/probes/probe.js";

const WINDOW_MS = 500; // rate window
const FEED = 64; // recent switches kept per CPU
const TIME_COLS = 256; // max per-CPU history kept; the heatmap renders the most
//                        recent `gridCols` of it, so it widens with the terminal
const TOP = 16; // processes kept in the top-by-CPU-time list

const events = new RingBuf(control, "events");
const knobs = new DataSec(control, "probe.data");

const commStr = (c) => {
  if (typeof c === "string") return c.replace(/\0.*$/s, "");
  if (!c) return "";
  let s = "";
  for (const b of c) { if (b === 0) break; s += String.fromCharCode(b); }
  return s;
};

// Per-CPU state: [{ rate, recent: [{prev, next, slice}] }]. One ring-buffer
// subscription feeds every CPU; the window timer publishes a snapshot. The
// subscription is set up when the signal is first watched and torn down when
// it isn't — that's what from() gives us.
const blankCpu = () => ({ rate: 0, recent: [], hist: new Array(TIME_COLS).fill(0) });

// Top processes by on-CPU time, recomputed each window. A plain signal fed
// from `cpus`'s subscription below — the ring buffer is single-consumer, so
// one subscription drives both signals (this updates whenever `cpus` is
// watched, which the UI always does). Each entry is { comm, ns, pct }, where
// `pct` is the share of all CPU time available in the window.
export const procs = signal([]);

export const cpus = from((state) => {
  const acc = Array.from({ length: numCpus }, blankCpu);
  let procAcc = new Map(); // comm -> on-CPU ns accumulated this window
  const sub = events.subscribe((w) => {
    const e = w?.sched_event ?? w;
    const c = e && acc[e.cpu];
    if (!c) return;
    c.count = (c.count || 0) + 1;
    const prev = commStr(e.prev_comm);
    const slice = Number(e.slice_ns);
    c.recent.unshift({ prev, next: commStr(e.next_comm), slice });
    if (c.recent.length > FEED) c.recent.pop();
    // The outgoing task just ran `slice` ns on this CPU — credit it.
    procAcc.set(prev, (procAcc.get(prev) || 0) + slice);
  });
  const secs = WINDOW_MS / 1000;
  const capacity = numCpus * WINDOW_MS * 1e6; // ns of CPU time per window
  const h = setInterval(() => {
    state.set(acc.map((c) => {
      const rate = (c.count || 0) / secs;
      c.count = 0;
      c.hist.push(rate); // scroll the per-CPU history one column
      c.hist.shift();
      return { rate, recent: c.recent.slice(), hist: c.hist.slice() };
    }));
    procs.set(
      [...procAcc.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP)
        .map(([comm, ns]) => ({ comm, ns, pct: (ns / capacity) * 100 })),
    );
    procAcc = new Map();
  }, WINDOW_MS);
  return () => { clearInterval(h); sub.then(_.unsubscribe()); };
}, Array.from({ length: numCpus }, blankCpu));

// The runtime knob, in microseconds for the UI. Initial value MUST match
// the program's compiled default (1ms) so the display matches the kernel
// before the first patch. Writing it patches the kernel-side global live.
export const minSlice = signal(1000);

export function setMinSlice(us) {
  us = Math.max(0, us);
  minSlice.set(us);
  // min_slice_ns is __u64 — DataSec.patch wants a BigInt for 64-bit fields.
  knobs.patch({ min_slice_ns: BigInt(us * 1000) });
}
