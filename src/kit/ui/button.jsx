/* button — a padded, clickable label with built-in pointer styling. Three
 * visual tiers driven by the pointer (idle / hover / pressed, the CSS :active
 * sense) plus an orthogonal caller-driven `selected` overlay for a toggle that
 * is currently on. A stateful switch that *remembers* its own on/off is a
 * different widget; `selected` here is controlled — the caller owns the state.
 *
 * Framework-generic: no theme, no tooltip bus. Colors come from a `tone` prop
 * (sensible defaults built in), and everything else — `onClick`, a `{...tip()}`
 * tooltip spread, sizing, a `bg` override — forwards straight to the Box. The
 * framework composes same-event handlers, so a forwarded `onMouseEnter` and the
 * internal hover tracking coexist rather than clobber.
 */

import { Box, Text, signal, computed, toSignal } from "yeet:tui";

/* Neutral solarized-ish defaults so the button renders standalone; an app
 * passes `tone` to reskin. `ink` is the text on an accent fill. */
const TONE = { accent: "#b58900", ink: "#fdf6e3", dim: "#93a1a1", hover: "#1b2433" };

/* Pressed and selected both read as an accent fill (pressed is transient, so it
 * flashes as click feedback); hover lifts the faint highlight; idle is bare. */
const bgFor = (t, sel, hov, prs) => (prs || sel ? t.accent : hov ? t.hover : undefined);
const inkFor = (t, sel, hov, prs) =>
  prs || sel ? { fg: t.ink, bold: true } : hov ? { fg: t.accent, bold: true } : { fg: t.dim, bold: false };

/* Mirror internal pointer state to a caller's optional setter (fn or Signal),
 * so a parent can observe hover / pressed while the button styles itself. */
const push = (sig, fwd) => (v) => {
  sig.set(v);
  if (typeof fwd === "function") fwd(v);
  else fwd?.set?.(v);
};

export default function Button(opts, ...kids) {
  const { selected = false, tone = TONE, setHover, setPressed, ...rest } = opts;
  const hovered = signal(false);
  const pressed = signal(false);
  const sel = toSignal(selected);
  const dropPress = push(pressed, setPressed);

  /* Computed signals, not thunks: `bg`'s value slot takes a Signal (a bare
   * function there is a per-cell shader, not a reactive read). */
  const bg = computed(() => bgFor(tone, sel.get(), hovered.get(), pressed.get()));
  const ink = computed(() => inkFor(tone, sel.get(), hovered.get(), pressed.get()));
  return (
    <Box
      width="fit"
      padding={[0, 1]}
      height={1}
      bg={bg}
      setHover={push(hovered, setHover)}
      // defaults above are overridable by `rest`; the press handlers below
      // re-invoke `rest`'s so they compose (pressed has no declarative setter
      // like setHover, so the widget tracks it by hand).
      {...rest}
      onMouseDown={(e) => {
        rest.onMouseDown?.(e);
        dropPress(true);
      }}
      onMouseUp={(e) => {
        rest.onMouseUp?.(e);
        dropPress(false);
      }}
      onMouseLeave={(e) => {
        rest.onMouseLeave?.(e);
        dropPress(false);
      }}
    >
      <Text break="none" fg={() => ink.get().fg} bold={() => ink.get().bold}>
        {kids}
      </Text>
    </Box>
  );
}
