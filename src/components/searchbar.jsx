/* wssnoop/searchbar — the free-text query line, shown above the minibuffer only
 * while a search is being typed or a query is live. It's context-labelled: the
 * same box filters the message log when the inspector is open, the connection
 * table otherwise (main.jsx routes keystrokes; controls.js holds the state). */

import { Box, Text, bold, fg } from "yeet:tui";
import { pipe } from "yeet:helpers";

import { search, searchActive, isInspecting, searchHasFields } from "../controls.js";
import { COL } from "../palette.js";

export default function SearchBar() {
  return (
    <Box height={() => (searchActive.get() || search.get() ? 1 : 0)} overflow="hidden">
      <Text break="none">
        {() => {
          const active = searchActive.get();
          const q = search.get();
          if (!active && !q) return "";
          /* In the table a `$.field` query doesn't hide rows — it counts matching
           * messages per service (see Agg), so label that scope distinctly. */
          const fieldTable = !isInspecting() && searchHasFields();
          const scope = isInspecting() ? "messages" : fieldTable ? "matches" : "connections";
          /* The query is a field language, not just text; teach the syntax while
           * the box is empty (both scopes support it) so it's discoverable. */
          const hint =
            !q
              ? "  text, or a field test: $.price>100  ·  $.type==\"trade\"  ·  $.error"
              : fieldTable
                ? "   matching messages per service →   ·   esc: clear"
                : active
                  ? "   enter: keep · esc: clear"
                  : "   esc: clear";
          return [
            pipe(`  /${scope} `, fg(COL.accent), bold),
            fg(COL.ink)(q),
            active ? fg(COL.accent)("▏") : "",
            fg(COL.header)(hint),
          ];
        }}
      </Text>
    </Box>
  );
}
