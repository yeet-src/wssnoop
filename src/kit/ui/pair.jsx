/* wssnoop/pair — a two-sided stat (sent ↑ / received ↓, or up / down byte
 * totals) rendered as two spans that share one tooltip. Resting the pointer on
 * a side doesn't restyle the figure; instead the tooltip emboldens *that side's*
 * label, so the explanation itself focuses on whichever half you're over.
 *
 * The sides are fit-width (the default Box width is 1fr, which would spread them
 * across the row) and differ only by figure/color/label, so they're the same
 * Side with a latent parameter; callers vary the separators (" · ", " ", " / ")
 * to match each site's surrounding line. */

import { Box, Text, fg, bold } from "yeet:tui";
import { pipe } from "yeet:helpers";

import { tip } from "./tooltip.js";
import { theme } from "./theme.js";

/* The shared tooltip: `desc` names the stat, then each side's label, with the
 * hovered side in its own color + bold and the other dimmed. */
const tipFor = (desc, up, down, hotUp) => [
  pipe(`${desc} · `, fg(theme.dim)),
  hotUp ? pipe(up.label, fg(up.color), bold) : pipe(up.label, fg(theme.dim)),
  pipe(" · ", fg(theme.dim)),
  hotUp ? pipe(down.label, fg(theme.dim)) : pipe(down.label, fg(down.color), bold),
];

/* `text` is a thunk (figures climb live). The figure renders plainly in its
 * color; the focus cue lives in the tooltip, not here. */
const Side = ({ color, text, title }) => (
  <Box direction="row" width="fit" height={1} break="none" {...tip(title)}>
    <Text break="none">{() => pipe(text(), fg(color))}</Text>
  </Box>
);

export default function Pair({ desc, lead, sep, up, down, ...rest }) {
  return (
    <Box direction="row" width="fit" height={1} break="none" {...rest}>
      {lead != null ? <Text break="none">{lead}</Text> : null}
      <Side color={up.color} text={up.text} title={() => tipFor(desc, up, down, true)} />
      <Text break="none">{sep}</Text>
      <Side color={down.color} text={down.text} title={() => tipFor(desc, up, down, false)} />
    </Box>
  );
}
