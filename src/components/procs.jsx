// Top processes by on-CPU time in the last window — a live ranked bar chart
// that fills the space beside the heatmap. Reads the `procs` signal (already
// sorted, each entry { comm, ns, pct }). `width`/`maxRows` come from the
// responsive layout. Bars are scaled to the busiest process and share the
// heatmap's inferno ramp; the label is the command and its share of total CPU
// time. Only switches the kernel emitted are counted, so sub-`min-slice` tasks
// don't show — it tracks CPU hogs, not every wakeup.
import { Box, Text, bold, fg, idx } from "yeet:tui";
import { heat, lpad, pad } from "@/lib/format.js";

const NAMEW = 15; // command column width
const PCTW = 7; // "100.0%" + a space

export default ({ procs, width, maxRows }) => (
  <Box>
    <Text height="1">
      {fg(idx(244))("  top processes · on-cpu time   (per 500ms window)")}
    </Text>
    <Box>
      {() => {
        const list = procs.get();
        const barW = Math.max(6, width - NAMEW - PCTW - 3);
        const shown = list.slice(0, maxRows);
        if (!shown.length) {
          return [<Text height="1">{fg(idx(240))("   (idle — no qualifying switches yet)")}</Text>];
        }
        const top = shown[0].pct || 1; // scale bars to the busiest process

        return shown.map((p) => {
          const frac = p.pct / top;
          const w = Math.max(1, Math.round(frac * barW));
          return (
            <Text height="1" break="none">
              {[
                fg(idx(252))(`  ${pad(p.comm, NAMEW)}`),
                fg(heat(frac))("█".repeat(w)),
                fg(idx(237))("·".repeat(Math.max(0, barW - w))),
                bold(fg(idx(250))(lpad(`${p.pct.toFixed(1)}%`, PCTW))),
              ]}
            </Text>
          );
        });
      }}
    </Box>
  </Box>
);
