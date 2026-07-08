/* wssnoop/help — the explanatory overlay behind the ? button. Modelled on the
 * inspector's drawer look: a translucent scrim dims (and click-dismisses) the
 * dashboard, and a centered opaque panel floats on top. Content is data
 * (SECTIONS) rendered by one compact pass.
 *
 * The panel's opaque `bg` occludes the table (text and sparklines) beneath it
 * (yeet handles buffer/text occlusion since YEET-DX-NOTES.md #20's fix). It does
 * need a definite `width` though — a Layer child with only left+right insets
 * sizes to its content, not its rect — so it's centered at an explicit width. */

import { Box, Text, Layer, bold, fg, computed } from "yeet:tui";
import { pipe } from "yeet:helpers";

import Button from "../kit/ui/button.jsx";
import { tip } from "../kit/ui/tooltip.js";
import { COL } from "../palette.js";
import { closeHelp } from "../controls.js";

/* Each section is a heading + [term, definition] rows. Kept terse — the screen
 * orients, the tooltips teach the detail. */
const SECTIONS = [
  {
    h: "Reading the table",
    rows: [
      ["ROLE", "client = we dialed out · server = we serve it"],
      ["DEST", "destination wss:// (or ws://) URL · ~ip:port when only the peer is known · 'unknown connection' otherwise"],
      ["MSG ↑/↓", "WebSocket messages sent / received"],
      ["ACTIVITY", "bytes/sec per column · upper ▀ sent, lower ▄ received · brighter = more"],
      ["↑/↓ on headers", "aggregate per process/container/ALL · bandwidth or messages (agg / m)"],
    ],
  },
  {
    h: "Activity crosshair",
    rows: [
      ["hover a bar", "drops a vertical line through every bar at that instant"],
      ["click a bar", "pins the moment (focus) so the line stays · click again or Esc to release"],
    ],
  },
  {
    h: "Inspecting a connection",
    rows: [
      ["click a row", "open its live, scrollable message log"],
      ["click a message", "expand pretty JSON (decompressed if it arrived deflated)"],
      ["⊕ details", "subprotocol, extensions, opcode histogram, close codes"],
      ["⧉ copy all", "messages as JSONL → clipboard (respects the active filter)"],
      ["⊙ focus", "pin kernel capture to this one connection · silences the rest in-kernel"],
    ],
  },
  {
    h: "Search / filter  (press /)",
    rows: [
      ["text", "case-insensitive substring · connections, or messages while inspecting"],
      ["$.path OP val", "test a message's decoded JSON body"],
      ["operators", "> >= < <= (numeric) · == != (typed) · ~ (substring) · $.x (present)"],
      ["examples", '$.price>100    $.type=="trade"    $.sym~usd    $.error'],
      ["a $.field in the table", "counts matching / total messages per service (e.g. $.error)"],
    ],
  },
];

const KEYS = "q quit · / search · Esc back · s sort · r role · i idle · a rows · m metric · [ ] window · ? help";
const TERM = 17;
const PANEL_W = 98; // fits the widest line; capped to the terminal below

const Row = ([term, desc]) => (
  <Text height={1} break="none">{[fg(COL.dim)(term.padEnd(TERM)), fg(COL.header)(desc)]}</Text>
);
const blank = () => <Text height={1}>{" "}</Text>;

export default function Help({ size }) {
  const geom = computed(() => {
    const cols = size.get().cols;
    const w = Math.min(PANEL_W, cols - 4);
    return { w, left: Math.max(0, Math.floor((cols - w) / 2)) };
  });
  return (
    <Layer>
      {/* scrim: dims the dashboard and dismisses on click (the panel is on top,
          so a click inside it never reaches here). */}
      <Box left={0} right={0} top={0} bottom={0} bg={COL.scrim} onClick={closeHelp} />
      {/* the panel: a definite width + full body height, opaque bg (occludes the
          table beneath) over a round border. */}
      <Box
        width={() => geom.get().w}
        left={() => geom.get().left}
        top={0}
        bottom={0}
        z={1}
        bg={COL.panel}
        border={{ line: "round", fg: COL.header }}
        padding={[0, 1]}
        direction="column"
        overflow="hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <Box direction="row" height={1}>
          <Button {...tip("close help (Esc)")} onClick={closeHelp}>‹ close</Button>
          <Box width={2} break="none" />
          <Text break="none">{pipe("wssnoop · help", fg(COL.title), bold)}</Text>
        </Box>
        {blank()}
        {SECTIONS.map((sec) => [
          <Text height={1} break="none">{pipe(sec.h, fg(COL.accent), bold)}</Text>,
          ...sec.rows.map(Row),
          blank(),
        ])}
        <Text height={1} break="none">{fg(COL.header)(KEYS)}</Text>
        {blank()}
        <Text height={1} break="none">{fg(COL.header)("press ? or Esc to close")}</Text>
      </Box>
    </Layer>
  );
}
