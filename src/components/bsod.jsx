/* wssnoop/bsod — a last-resort error screen. mount() owns the alt buffer and
 * cursor; if building the view throws at setup, re-mounting this keeps that
 * lifecycle clean instead of dumping a raw stack over a half-torn-down screen.
 * (It can't catch a hard V8-worker death — that closes the TTY with no JS hook
 * to run — only synchronous setup errors; runtime faults degrade to the status
 * line instead, see state.js.) */

import { Box, Text, bold, italic, fg } from "yeet:tui";
import { pipe } from "yeet:helpers";

const BLUE = "#002b6b";
const WHITE = "#fdf6e3";

export default function Bsod({ error }) {
  const lines = String(error?.stack ?? error?.message ?? error).split("\n");
  return (
    <Box bg={BLUE} width="1fr" height="1fr" padding={2} direction="column">
      <Text break="none">{pipe(":(  wssnoop hit an error", fg(WHITE), bold)}</Text>
      <Text break="none">{" "}</Text>
      {lines.slice(0, 30).map((l) => (
        <Text break="anywhere">{fg(WHITE)(l || " ")}</Text>
      ))}
      <Text break="none">{" "}</Text>
      <Text break="none">{pipe("press q to quit", fg("#93a1a1"), italic)}</Text>
    </Box>
  );
}
