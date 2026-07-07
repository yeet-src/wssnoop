/* wssnoop/palette — the presentation palette. Solarized-ish tones, chosen to
 * read on both light and dark terminals. Shared across the UI components; the
 * data layers (lib/*, state.js) never see a color. The sparkline heat *ramps*
 * are built here too (from the generic factory in lib/heat.js): the ramp math is
 * generic, but the hue choices are a palette decision, so they belong here. */
import { heatPalette } from "./lib/heat.js";

export const COL = {
  /* surface — explicit so the dashboard never shows through to the terminal
   * default; a hair darker than the sparkline TRACK (#161b22) so the idle rails
   * still read as faint rectangles against it. */
  bg: "#0d1117",

  /* chrome */
  title: "#268bd2",
  hover: "#1b2433", /* faint row highlight under the pointer (a hair above bg) */
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
  panelFade: ["#11161f59", "#11161fa6", "#11161fe6"], /* panel (#11161f) + rising alpha — the edge-fade gradient */
  scrollTrack: "#586e75bb", /* overlay scrollbar rail — translucent, text shows faintly */
  scrollThumb: "#268bd2", /* overlay scrollbar thumb — opaque, like a browser overlay  */
  warn: "#dc322f", /* inflate failure / error badge                       */
  snip: "#b58900", /* capture truncated — a calm caution, not an error     */
  ok: "#859900", /* healthy / open status                                */
  crash: "#002b6b", /* the BSOD backdrop                                   */

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

/* Sparkline heat variants — one hue pair per table layer, so the connection
 * rows, the per-process aggregate, and the global bar read distinct at a glance
 * (warm = egress/up, cool = ingress/down within each; distinct families across).
 * The ramp machinery is generic (lib/heat.js); these are the wssnoop choices. */
const HUES = {
  conn: { up: 0xf5a623, down: 0x1fb6a6 }, // amber / teal
  agg: { up: 0xb36ae2, down: 0x5b6cf0 }, // violet / indigo
  global: { up: 0xffd24d, down: 0x35c7e8 }, // gold / cyan
};

/* The heat ramps for a sparkline variant: `up` (fg, top half = egress), `down`
 * (bg, bottom half = ingress), and the shared idle `track`. */
export const heatFor = (variant = "conn") => heatPalette(HUES[variant] ?? HUES.conn);
