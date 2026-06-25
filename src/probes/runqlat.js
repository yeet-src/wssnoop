// Run-queue latency probe. The companion BPF program (runqlat.bpf.c)
// aggregates wakeup→on-CPU latency into a log2 histogram in an ARRAY map;
// this side just POLLS that map on a timer — the map-as-aggregate egress,
// in contrast to cpusched's ring-buffer stream.
import { ArrayMap } from "yeet:bpf";
import { from } from "yeet:tui";
import { control } from "@/probes/probe.js";

export const SLOTS = 27; // must match MAX_SLOTS in runqlat.bpf.c
const POLL_MS = 500;

const hist = new ArrayMap(control, "runq_hist");

// Cumulative counts per log2(latency_ns) bucket, refreshed each poll.
export const latency = from((state) => {
  const h = setInterval(async () => {
    const slots = new Array(SLOTS).fill(0);
    await Promise.all(
      Array.from({ length: SLOTS }, async (_v, i) => {
        const v = await hist.lookup(i);
        slots[i] = v == null ? 0 : Number(v);
      }),
    );
    state.set(slots);
  }, POLL_MS);
  return () => clearInterval(h);
}, new Array(SLOTS).fill(0));
