/* format — the presentation primitives that turn raw numbers into the short
 * strings and the two-ramp heat the UI paints with. Pure: strings and color
 * combinators only, no signals or BPF, so it's safe to import anywhere.
 *
 * The dashboard reads two flows at once — egress (up, what we send) and ingress
 * (down, what we receive) — stacked in one half-block sparkline cell (▀): the
 * top half is foreground, the bottom half is background. `heatFor(variant)`
 * yields the matching pair of ramps (`up` → fg, `down` → bg) plus the idle
 * `track`; each ramp encodes magnitude as brightness within one hue, so the two
 * halves stay legible together and quiet cells recede onto the track. */

import { rgb } from "yeet:tui";

/* ---- byte / rate / age formatters ----------------------------------- */

/* 1234 -> "1.2K", 12_345 -> "12.0K", 1_200_000 -> "1.1M" (1024-based). */
export function fmtBytes(n) {
  if (!(n > 0)) return "0B";
  const u = ["B", "K", "M", "G", "T"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return (i === 0 ? Math.round(n) : n.toFixed(1)) + u[i];
}

/* elapsed ms -> "now" / "3s" / "2m" / "1h". */
export function fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/* Tokenize one line of (pretty-printed) JSON into typed spans the UI colors:
 * `key` (a "..." immediately before a colon), `str`, `num`, `lit`
 * (true/false/null), `punct`, and `ws`. Pure — returns {text, kind}[]; the
 * component maps kind → face. Line-based so it composes with the inspector's
 * line-per-Text rendering. */
export function jsonTokens(line) {
  const out = [];
  const push = (text, kind) => text && out.push({ text, kind });
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
      push(line.slice(i, j), "ws");
      i = j;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === '"') { j++; break; }
        j++;
      }
      let k = j;
      while (line[k] === " ") k++;
      push(line.slice(i, j), line[k] === ":" ? "key" : "str");
      i = j;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      while (j < line.length && /[-\d.eE+]/.test(line[j])) j++;
      push(line.slice(i, j), "num");
      i = j;
    } else if (line.startsWith("true", i) || line.startsWith("false", i) || line.startsWith("null", i)) {
      const lit = line.startsWith("true", i) ? "true" : line.startsWith("false", i) ? "false" : "null";
      push(lit, "lit");
      i += lit.length;
    } else if ("{}[]:,".includes(ch)) {
      let j = i;
      while (j < line.length && "{}[]:,".includes(line[j])) j++;
      push(line.slice(i, j), "punct");
      i = j;
    } else {
      push(ch, "text");
      i++;
    }
  }
  return out;
}

/* Classic `offset  hex…  ascii` dump of a byte slice, for inspecting binary
 * (and undecodable) message payloads. Caps at `maxBytes` with a "… N more"
 * note so a huge frame can't blow up the panel; returns one string with "\n"
 * between rows (the inspector splits it into Text lines). */
export function hexDump(u8, maxBytes = 512) {
  if (!u8 || !u8.length) return "";
  const n = Math.min(u8.length, maxBytes);
  const rows = [];
  for (let off = 0; off < n; off += 16) {
    const end = Math.min(off + 16, n);
    let hex = "";
    let asc = "";
    for (let i = 0; i < 16; i++) {
      if (off + i < end) {
        const b = u8[off + i];
        hex += b.toString(16).padStart(2, "0") + " ";
        asc += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
      } else {
        hex += "   ";
      }
      if (i === 7) hex += " ";
    }
    rows.push(`${off.toString(16).padStart(6, "0")}  ${hex} ${asc}`);
  }
  if (u8.length > n) rows.push(`… ${u8.length - n} more bytes`);
  return rows.join("\n");
}

/* ---- the heat ramps ------------------------------------------------- */

/* Magnitude reads as *brightness*, not hue: each ramp holds one hue and walks
 * it from a dark, slightly-tinted floor up to the full color, with a perceptual
 * (gamma) curve so equal steps look equal. So a cell's value is legible as how
 * light it is, and the hue only says which series/level it belongs to. Idle
 * cells sit on a flat dark TRACK (explicit rgb — never DEFAULT, which painted as
 * holes against the surrounding UI).
 *
 * Three variants keep the table layers apart at a glance — connection rows, the
 * per-process aggregate, and the global bar each get their own hue pair (warm =
 * egress/up, cool = ingress/down within each, but distinct families across):
 *   conn   amber / teal        agg   violet / indigo        global  gold / cyan
 */

const R = (c) => (c >> 16) & 0xff;
const G = (c) => (c >> 8) & 0xff;
const B = (c) => c & 0xff;
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const blend = (lo, hi, t) => rgb(lerp(R(lo), R(hi), t), lerp(G(lo), G(hi), t), lerp(B(lo), B(hi), t));

/* The idle track: a dark neutral the empty cells paint, so a quiet sparkline is
 * a flat dark rail rather than a ragged mix of defaults. */
const TRACK = 0x161b22;
const TRACK_RGB = rgb(TRACK);

/* hue → (frac → rgb): blend TRACK→hue from a 0.22 floor (so the faintest traffic
 * still lifts off the rail) to 1.0, on a perceptual brightness curve. */
const mkRamp = (hue) => (frac) =>
  !(frac > 0) ? TRACK_RGB : blend(TRACK, hue, 0.22 + 0.78 * Math.pow(Math.min(1, frac), 0.55));

const HUES = {
  conn: { up: 0xf5a623, down: 0x1fb6a6 }, // amber / teal
  agg: { up: 0xb36ae2, down: 0x5b6cf0 }, // violet / indigo
  global: { up: 0xffd24d, down: 0x35c7e8 }, // gold / cyan
};

/* The ramps a sparkline variant paints with: `up` (fg, top half = egress),
 * `down` (bg, bottom half = ingress), and the shared idle `track`. */
export const heatFor = (variant = "conn") => {
  const h = HUES[variant] ?? HUES.conn;
  return { up: mkRamp(h.up), down: mkRamp(h.down), track: TRACK_RGB };
};
