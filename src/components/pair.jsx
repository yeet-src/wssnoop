/* wssnoop/pair — a two-sided stat (sent ↑ / received ↓, or up / down byte
 * totals) rendered as two independently hoverable spans. Resting the pointer on
 * one side emboldens that side and surfaces its own tip, so the figure you're
 * reading stands out from its twin instead of sharing one catch-all tooltip.
 *
 * Module-keyed hover (hover.js), not a local signal, on purpose: the inspector
 * re-mints its detail lines every heartbeat, which would reset a local hover
 * boolean twice a second — the keyed highlight survives that rebuild.
 *
 * The two sides differ only by which figure and color they carry, so they're
 * the same Side with a latent parameter; callers vary the leading/middle
 * separators (" · ", " ", " / ") to match each site's surrounding line. */

import { Box, Text, fg, bold } from "yeet:tui";
import { pipe } from "yeet:helpers";

import { hoverTip, hovered } from "./hover.js";

/* `text` is a thunk (counts climb live); `title` is a string or thunk, per the
 * hover API. Thread the figure through its color, then bold it only while this
 * exact side is hovered. */
const Side = ({ k, color, title, text }) => (
  <Box direction="row" height={1} break="none" {...hoverTip(k, title)}>
    <Text break="none">{() => pipe(text(), fg(color), ...(hovered(k) ? [bold] : []))}</Text>
  </Box>
);

export default function Pair({ keyId, lead, sep, up, down }) {
  return (
    <Box direction="row" height={1} break="none">
      {lead != null ? <Text break="none">{lead}</Text> : null}
      <Side k={`${keyId}:up`} color={up.color} title={up.title} text={up.text} />
      <Text break="none">{sep}</Text>
      <Side k={`${keyId}:dn`} color={down.color} title={down.title} text={down.text} />
    </Box>
  );
}
