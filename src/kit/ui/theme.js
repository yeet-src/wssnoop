/* theme — the semantic color roles the reusable UI kit paints with. Kit-generic:
 * the kit names the *roles*, an app supplies the *values*. A widget references a
 * role (`theme.accent`), never a literal, so one `applyTheme` call at startup
 * reskins the whole kit and the widgets carry no app palette dependency.
 *
 * Ships neutral defaults so the kit renders standalone; an app overrides the
 * roles it cares about. Values are plain color specs (`#rrggbb[aa]`, or anything
 * `fg`/`bg` accept), read at render time — call `applyTheme` before mounting.
 * (A live theme swap would need the widgets to read a signal; deferred until
 * there's a second consumer to design it against.) */

const defaults = {
  accent: "#b58900", /* toggles, active state, the live cursor          */
  ink: "#ffffff", /* text on an accent fill                          */
  dim: "#93a1a1", /* secondary text, idle labels                    */
  hover: "#1b2433", /* the faint highlight under the pointer          */
  header: "#586e75", /* column headers, the resting hint               */
  crash: "#002b6b", /* the last-resort error screen backdrop          */
};

export const theme = { ...defaults };

/* Merge an app's role values over the defaults. Idempotent; call once at startup
 * before the first mount. */
export const applyTheme = (roles) => Object.assign(theme, roles);
