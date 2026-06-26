/* wssnoop/palette — the presentation palette. Solarized-ish tones, chosen to
 * read on both light and dark terminals. Shared across the UI components; the
 * data layers (lib/*, state.js) never see a color. (The two heat *ramps* for
 * the sparkline live in lib/format.js, next to the numbers they encode.) */
export const COL = {
  /* surface — explicit so the dashboard never shows through to the terminal
   * default; a hair darker than the sparkline TRACK (#161b22) so the idle rails
   * still read as faint rectangles against it. */
  bg: "#0d1117",

  /* chrome */
  title: "#268bd2",
  header: "#586e75", /* column-header labels        */
  dim: "#93a1a1",
  accent: "#b58900",
  ink: "#fdf6e3", /* light text for use on an accent fill (active button) */

  /* connection role */
  client: "#268bd2", /* we initiated (egress GET)   */
  server: "#859900", /* we are serving              */
  unknown: "#657b83", /* mid-stream / role unknown   */

  /* summary stats */
  out: "#b58900", /* egress / up                 */
  in: "#2aa198", /* ingress / down              */

  /* inspector overlay */
  scrim: "#05080dcc", /* translucent wash dimming the list behind the panel */
  panel: "#11161f", /* the panel's opaque surface (a hair above bg)        */
  shadow: "#010409", /* the ▒ drop-shadow cast on the panel's right/bottom  */
  warn: "#dc322f", /* inflate failure / error badge                       */
  snip: "#b58900", /* capture truncated — a calm caution, not an error     */
  ok: "#859900", /* healthy / open status                                */

  /* JSON syntax highlighting (expanded payloads) */
  json: {
    key: "#268bd2", /* "key":      */
    str: "#859900", /* "value"     */
    num: "#2aa198", /* 123         */
    lit: "#b58900", /* true/null   */
    punct: "#586e75", /* { } [ ] , : */
    text: "#93a1a1",
  },
};

/* JSON token kind → color, for highlightable payload lines. */
export const jsonColor = (kind) => COL.json[kind] ?? COL.json.text;

export const roleColor = (role) =>
  role === "client" ? COL.client : role === "server" ? COL.server : COL.unknown;
