/* wssnoop/help — the explanatory screen behind the ? button. A full-body swap
 * (not a z-overlay: a stacked box can't occlude the sparklines beneath, DX #20),
 * so root hides the table + inspector while it's open. Content is data (SECTIONS)
 * rendered by one compact pass; close with the back button, ?, or Esc. */

import { Box, Text, bold, fg } from "yeet:tui";
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

const Row = ([term, desc]) => (
  <Text height={1} break="none">
    {[fg(COL.dim)(term.padEnd(TERM)), fg(COL.header)(desc)]}
  </Text>
);

const blank = () => <Text height={1}>{" "}</Text>;

export default function Help() {
  return (
    <Box width="1fr" height="1fr" bg={COL.bg} direction="column" padding={[1, 2]} overflow="hidden">
      <Box direction="row" height={1}>
        <Button title="close help (Esc)" onClick={closeHelp}>‹ close</Button>
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
      <Text height={1} break="none">{pipe("press ? or Esc to close", fg(COL.header))}</Text>
    </Box>
  );
}
