# src/kit — the extraction-bound kit

Wssnoop-agnostic, reusable code, kept apart from the app so the eventual move
into shared **yeet** modules is a clean directory lift, not an archaeology dig.

Nothing here knows about wssnoop. The one rule that keeps it that way:

> A `kit/` module imports **only** `yeet:*` and other `kit/` siblings — never
> `../controls`, `../palette`, `../state`, `../probes`, `../components`, or
> `../lib`.

The dependency arrow points one way: the app (`components/`, `controls.js`,
`palette.js`, `main.jsx`, …) depends on the kit; the kit never depends back. The
app supplies the values the kit is parameterized over — `palette.js` installs
the color roles via `applyTheme`, `root.jsx` passes the minibuffer its `hint`
and `priority`.

## Contents

Pure primitives (no signals, no I/O):

| module | what it is |
|---|---|
| `fmt.js` | `fmtBytes`, `fmtAgo` — value → short display string |
| `json.js` | `parseJson`, `jsonTokens` — safe parse + a line tokenizer for highlighting |
| `hexdump.js` | `hexDump` — the classic offset/hex/ascii view of a byte slice |
| `bytes.js` | `utf8Bytes`, `base64` — the byte codecs the bare V8 isolate lacks |
| `heat.js` | `heatPalette` — a two-series brightness-ramp factory for half-block sparklines |
| `rankmap.js` | `rankMap` — order a set as an id→rank map, descending by a metric |
| `query.js` | a message-filter DSL: `compile(q)` → a predicate over a record |
| `timehist.js` | `createTimeHist` / `mergeHists` — a time-bucketed two-series byte ring |
| `cgroup.js` | `containerOf` — a container id from a process's cgroup paths |
| `race.js` | `race(promise, ms)` — resolve, or reject on a timeout |

`ui/` — a reusable TUI widget kit for `yeet:tui`:

| module | what it is |
|---|---|
| `theme.js` | semantic color *roles* (accent/ink/dim/hover/header/crash) + `applyTheme`; widgets reference a role, the app supplies the value |
| `tooltip.js` | the hover status bus: `hoverTitle`, the shared highlight key, `toast`/`flash`, and the `tip`/`hoverTip`/`hoverBg` spreads |
| `button.jsx` | a padded clickable with built-in idle/hover/pressed styling + a controlled `selected` overlay; tone and all box props forward/override |
| `minibuffer.jsx` | a one-line status strip echoing the bus; app content is props (`hint`, `priority`) |
| `pair.jsx` | a two-sided stat (up/down) sharing one tooltip |
| `bsod.jsx` | a last-resort error screen; the app names it via `title` |

## When these move to ../yeet

Likely destinations (namespace-agnostic for now): the pure primitives extend
`yeet:helpers` or land as small `yeet:*` modules; `ui/` becomes a widget layer
alongside `yeet:tui`. The forcing function is a second consumer — `../httpinspect`
already re-implements `fmt.js`'s `fmtBytes`/`fmtAgo`.
