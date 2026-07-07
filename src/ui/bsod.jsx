/* bsod — a last-resort error screen. Kit-generic (reads the theme; `title` names
 * the app). mount() owns the alt buffer and cursor; if building the view throws
 * at setup, re-mounting this keeps that lifecycle clean instead of dumping a raw
 * stack over a half-torn-down screen. (It can't catch a hard V8-worker death —
 * that closes the TTY with no JS hook to run — only synchronous setup errors;
 * runtime faults degrade to a status line instead, see state.js.) */

import { Box, Text, bold, italic, fg } from "yeet:tui";
import { pipe } from "yeet:helpers";

import { theme } from "./theme.js";

export default function Bsod({ error, title = ":(  hit an error" }) {
  const lines = String(error?.stack ?? error?.message ?? error).split("\n");
  return (
    <Box bg={theme.crash} width="1fr" height="1fr" padding={2} direction="column">
      <Text break="none">{pipe(title, fg(theme.ink), bold)}</Text>
      <Text break="none">{" "}</Text>
      {lines.slice(0, 30).map((l) => (
        <Text break="anywhere">{fg(theme.ink)(l || " ")}</Text>
      ))}
      <Text break="none">{" "}</Text>
      <Text break="none">{pipe("press q to quit", fg(theme.dim), italic)}</Text>
    </Box>
  );
}
