/* wssnoop/searchbar — the free-text query line, shown above the minibuffer only
 * while a search is being typed or a query is live. It's context-labelled: the
 * same box filters the message log when the inspector is open, the connection
 * table otherwise (main.jsx routes keystrokes; controls.js holds the state). */

import { Box, Text, bold, fg } from "yeet:tui";

import { search, searchActive, isInspecting } from "../controls.js";
import { COL } from "./palette.js";

export default function SearchBar() {
  return (
    <Box height={() => (searchActive.get() || search.get() ? 1 : 0)} overflow="hidden">
      <Text break="none">
        {() => {
          const active = searchActive.get();
          const q = search.get();
          if (!active && !q) return "";
          const scope = isInspecting() ? "messages" : "connections";
          return [
            bold(fg(COL.accent)(`  /${scope} `)),
            fg(COL.ink)(q),
            active ? fg(COL.accent)("▏") : "",
            fg(COL.header)(active ? "   enter: keep · esc: clear" : "   esc: clear"),
          ];
        }}
      </Text>
    </Box>
  );
}
