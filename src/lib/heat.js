/* heat — a two-series brightness ramp for stacked half-block sparklines. Pure
 * (needs only `rgb`). Kit-generic: an extraction candidate for a shared yeet
 * module; the domain hue choices live with the presentation palette, not here.
 *
 * A sparkline reads two flows at once — an "up" series (the glyph's top half,
 * foreground) and a "down" series (bottom half, background). `heatPalette` turns
 * one hue per series into a matching pair of ramps plus a shared idle `track`.
 * Magnitude reads as *brightness*, not hue: each ramp holds one hue and walks it
 * from a dark, slightly-tinted floor up to the full color on a perceptual (gamma)
 * curve, so equal steps look equal and the two halves stay legible together.
 * Quiet cells recede onto the flat dark track. */

import { rgb } from "yeet:tui";

const R = (c) => (c >> 16) & 0xff;
const G = (c) => (c >> 8) & 0xff;
const B = (c) => c & 0xff;
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const blend = (lo, hi, t) => rgb(lerp(R(lo), R(hi), t), lerp(G(lo), G(hi), t), lerp(B(lo), B(hi), t));

/* The default idle track: a dark neutral empty cells paint, so a quiet sparkline
 * is a flat dark rail rather than a ragged mix of terminal defaults (which paint
 * as holes against a filled UI). */
export const TRACK = 0x161b22;

/* hue → (frac → rgb): blend track→hue from a 0.22 floor (so the faintest traffic
 * still lifts off the rail) to 1.0, on a perceptual brightness curve. */
const mkRamp = (track, hue) => (frac) =>
  !(frac > 0) ? rgb(track) : blend(track, hue, 0.22 + 0.78 * Math.pow(Math.min(1, frac), 0.55));

/* A two-series heat palette: `up`/`down` are 0xRRGGBB hues (up → fg/top half,
 * down → bg/bottom half); `track` is the idle rail. Returns `{ up, down, track }`
 * where up/down are `frac → rgb` ramps and track is a color int. */
export const heatPalette = ({ up, down, track = TRACK }) => ({
  up: mkRamp(track, up),
  down: mkRamp(track, down),
  track: rgb(track),
});
