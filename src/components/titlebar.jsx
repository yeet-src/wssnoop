// Status rail: brand, total switch rate across all CPUs, and the live
// min-slice knob value (what +/- patches into the kernel). A one-row Box
// tinted as the rail via the container's own bg — full width, no fragile
// space-fill.
import { Box, Text, bold, fg, idx } from "yeet:tui";
import { fmtDuration, fmtRate } from "@/lib/format.js";

const RAIL = idx(235);

export default ({ cpus, minSlice }) => (
  <Box height="1" direction="row" bg={RAIL}>
    <Text break="none">
      {() => {
        const total = cpus.get().reduce((s, c) => s + c.rate, 0);
        const sep = fg(idx(240))("  ▏  ");
        return [
          bold(fg(idx(214))(" ● cpusched ")), sep,
          bold(`${fmtRate(total)}`), fg(idx(245))(" switches/s"), sep,
          fg(idx(245))("min-slice ≥ "), bold(fmtDuration(minSlice.get() * 1000)), fg(idx(240))("  [ +/- ]"),
        ];
      }}
    </Text>
  </Box>
);
