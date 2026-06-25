// Run-queue latency as a log2 histogram. Reads the polled `latency` signal
// (cumulative counts per bucket) and draws a bar per bucket, the label
// being the bucket's lower bound.
import { Box, Text, fg, idx } from "yeet:tui";
import { fmtDuration, lpad } from "@/lib/format.js";

const LO = 8; // 2^8 ns = 256ns
const HI = 23; // 2^23 ns ≈ 8.4ms
const BARW = 16;

export default ({ latency, maxRows }) => (
  <Box>
    <Text height="1">{fg(idx(244))(" runqueue latency")}</Text>
    <Text height="1">{fg(idx(244))(" (wakeup → on-cpu)")}</Text>
    <Box>
      {() => {
        const slots = latency.get();
        const fit = Math.max(1, (maxRows ?? HI - LO + 3) - 2); // rows for bars (2 header lines)

        // Window the buckets to what fits, biased to the populated range, so a
        // short panel shows the live distribution instead of clipping it away.
        let lo = LO, hi = HI, first = -1, last = LO;
        for (let i = LO; i <= HI; i++) if (slots[i]) { if (first < 0) first = i; last = i; }
        if (first >= 0) { lo = first; hi = last; }
        if (hi - lo + 1 > fit) hi = lo + fit - 1; // clip to fit
        else { // grow back out for context
          hi = Math.min(HI, lo + fit - 1);
          lo = Math.max(LO, hi - fit + 1);
        }

        let peak = 1;
        for (let i = lo; i <= hi; i++) if (slots[i] > peak) peak = slots[i];
        const rows = [];
        for (let i = lo; i <= hi; i++) {
          const n = slots[i] || 0;
          const w = Math.round((n / peak) * BARW);
          rows.push(
            <Text height="1" break="none">
              {[
                fg(idx(244))(`${lpad(fmtDuration(2 ** i), 7)} `),
                fg(idx(75))("█".repeat(w)),
                fg(idx(240))(n ? ` ${n}` : ""),
              ]}
            </Text>,
          );
        }
        return rows;
      }}
    </Box>
  </Box>
);
