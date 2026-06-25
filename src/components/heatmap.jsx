// A real heatmap: one row per CPU, one column per time sample (newest on
// the right). Each cell is a block glyph (█) colored by the core's switch
// rate at that instant, scaled against the visible peak so hot cores read
// brighter than quiet ones. `gridCols`/`maxRows` come from the responsive
// layout: it renders the most recent `gridCols` of history and, when there
// are more cores than rows, windows the list to keep the selection in view.
import { Box, Text, bold, fg, idx } from "yeet:tui";
import { heat } from "@/lib/format.js";

const HEADER = "  cores × time   (newest → right)   brightness = switch rate";

export default ({ cpus, selected, gridCols, maxRows }) => (
  <Box>
    <Text height="1">
      {() => {
        const total = cpus.get().length;
        const shown = Math.min(maxRows, total);
        return fg(idx(244))(total > shown ? `${HEADER}   · ${total} cores` : HEADER);
      }}
    </Text>
    <Box>
      {() => {
        const list = cpus.get();
        const sel = selected.get();
        const total = list.length;
        const shown = Math.min(maxRows, total);

        // Window the rows to keep the selected core on screen.
        let start = 0;
        if (total > shown) start = Math.min(Math.max(0, sel - (shown >> 1)), total - shown);
        const view = list.slice(start, start + shown);

        let peak = 1;
        for (const c of view) for (const v of c.hist.slice(-gridCols)) if (v > peak) peak = v;

        return view.map((c, j) => {
          const i = start + j;
          const on = i === sel;
          const label = `${on ? "▸" : " "} cpu ${String(i).padStart(2)} `;
          const cells = c.hist
            .slice(-gridCols)
            .map((v) => fg(heat(v <= 0 ? 0 : Math.sqrt(v / peak)))("█"));
          return (
            <Text height="1" break="none">
              {[on ? bold(fg(idx(231))(label)) : fg(idx(245))(label), ...cells]}
            </Text>
          );
        });
      }}
    </Box>
  </Box>
);
