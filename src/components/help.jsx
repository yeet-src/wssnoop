/* wssnoop/help — the explanatory overlay behind the ? button. Modelled on the
 * inspector's proven drawer look: a translucent scrim dims (and click-dismisses)
 * the dashboard, and a panel floats on top. Content is data (SECTIONS) rendered
 * by one compact pass.
 *
 * Occlusion (see YEET-DX-NOTES.md #20): at higher z a *space* (0x20) is
 * transparent and a box `bg` is not a glyph, so neither hides what's beneath —
 * the table's text and sparklines bleed through a panel's blank cells. Two
 * defences: sparklines are blanked at the source while helpOpen is set
 * (sparkline.jsx), and every panel line is padded to the inner width with a
 * NON-BREAKING space (a real glyph, so it occludes, but renders blank). The
 * panel needs a definite `width` too (a Layer child with only left+right insets
 * sizes to its content, not its rect), so it's centered at an explicit width. */

import { Box, Text, Layer, bold, fg, computed } from "yeet:tui";
import { pipe } from "yeet:helpers";

import Button from "./button.jsx";
import { COL } from "../palette.js";
import { closeHelp } from "../controls.js";

/* Each section is a heading + [term, definition] rows. Kept terse — the screen
 * orients, the tooltips teach the detail. */
const SECTIONS = [
  {
    h: "Reading the table",
    rows: [
      ["ROLE", "client = we dialed out · server = we serve it"],
      ["DEST", "destination wss:// (or ws://) URL · '?' when unknown"],
      ["MSG ↑/↓", "WebSocket messages sent / received"],
      ["ACTIVITY", "bytes/sec per column · upper ▀ sent, lower ▄ received · brighter = more"],
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
    ],
  },
];

const KEYS = "q quit · / search · Esc back · s sort · r role · i idle · a rows · [ ] window · ? help";
const TERM = 17;
const PANEL_W = 98; // fits the widest line; capped to the terminal below
const NB = String.fromCharCode(0x00a0); // non-breaking space: a glyph that occludes but renders blank (#20)

/* A line filling the full inner width (border-to-border) with NBSP so every cell
 * carries a glyph and the table beneath can't bleed through — a 1-col NBSP inset
 * on the left (in place of box padding, whose empty cells would bleed), the
 * content, then NBSP to the edge. `used` is the content's visible length. */
const pad = (spans, used, innerW) =>
  [NB, spans, NB.repeat(Math.max(0, innerW - 1 - used))].flat();
const Line = (spans, used, innerW) => <Text height={1} break="none">{pad(spans, used, innerW)}</Text>;
const Row = (innerW) => ([term, desc]) =>
  Line([fg(COL.dim)(term.padEnd(TERM)), fg(COL.header)(desc)], TERM + desc.length, innerW);

export default function Help({ size }) {
  const geom = computed(() => {
    const cols = size.get().cols;
    const w = Math.min(PANEL_W, cols - 4);
    return { w, left: Math.max(0, Math.floor((cols - w) / 2)), innerW: w - 2 };
  });
  return (
    <Layer>
      {/* scrim: dims the dashboard and dismisses on click (the panel is on top,
          so a click inside it never reaches here). */}
      <Box left={0} right={0} top={0} bottom={0} bg={COL.scrim} onClick={closeHelp} />
      {/* the panel: a definite width + full body height, opaque bg over a round
          border. bg occludes the text beneath; sparklines are blanked at source. */}
      <Box
        width={() => geom.get().w}
        left={() => geom.get().left}
        top={0}
        bottom={0}
        z={1}
        bg={COL.panel}
        border={{ line: "round", fg: COL.header }}
        direction="column"
        overflow="hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {() => {
          const iw = geom.get().innerW;
          const blank = () => Line([], 0, iw);
          return [
            /* header row: the ‹ close button + title, then NBSP fill so the
               right of the row occludes the table too. */
            <Box direction="row" height={1}>
              <Text break="none">{NB}</Text>
              <Button title="close help (Esc)" onClick={closeHelp}>‹ close</Button>
              <Text break="none">
                {[NB.repeat(2), pipe("wssnoop · help", fg(COL.title), bold), NB.repeat(Math.max(0, iw - 26))]}
              </Text>
            </Box>,
            blank(),
            ...SECTIONS.map((sec) => [
              Line([pipe(sec.h, fg(COL.accent), bold)], sec.h.length, iw),
              ...sec.rows.map(Row(iw)),
              blank(),
            ]),
            Line([fg(COL.header)(KEYS)], KEYS.length, iw),
            blank(),
            Line([fg(COL.header)("press ? or Esc to close")], 23, iw),
          ];
        }}
      </Box>
    </Layer>
  );
}
