# yeet DX notes — footguns & missing stairs

A running log of friction hit while building **wssnoop** (a BPF+TUI yeet script):
things that cost real time, surprised us, or fail silently. Each entry is
*symptom → cause → workaround → suggested fix*, with a source citation when the
truth lived in the runtime rather than the docs.

Audience: the yeet runtime / `yeet:tui` maintainers. Nothing here is a wssnoop
bug — it's all platform DX.

Legend: **[silent]** fails with no error · **[doc-gap]** docs disagree with
reality · **[uncatchable]** can't be handled from JS.

---

## yeet:tui / JSX

### 1. The face combinators are deprecated, but every doc teaches them **[doc-gap]**
- **Symptom:** We wrote `bold(fg(COL.title)("wssnoop"))` everywhere, straight
  from the CLAUDE.md / AGENTS.md / README examples. All three guides use the
  combinator form exclusively.
- **Cause:** In the runtime, the blessed form is `<Text fg=… bold>…</Text>`; the
  combinators are explicitly `@deprecated`, kept only for back-compat.
  > `crates/common/src/v8/loader/rule/yeet/tui/module.js:388-396`
  > ```js
  > // @deprecated — the named face combinators. Use `<Text fg=… bold>…</Text>`,
  > // or `face(patch)`. Kept working for back-compat.
  > export const fg = c => face({ fg: c });
  > export const [bold, dim, italic, …] = […].map(k => face({ [k]: true }));
  > ```
  > And line ~370: *"Its bare attrs are a face (`fg`/`bg` a colour, the rest an attr)."*
- **Workaround:** Read the runtime source. There is no other signal — no console
  warning, no lint, no types marking `@deprecated`.
- **Suggested fix:** Update the three guides to lead with `<Text fg=… bold>` and
  `face(patch)` for runtime-computed patches; demote the combinators to a
  "deprecated, back-compat" footnote. Optionally emit a one-time dev-mode warning
  when a combinator is called.

### 2. Multi-span styled text has no clean prop form
- **Symptom:** A line like `[fg(out)("↑"), fg(dim)(n), fg(role)(name)]` (per-span
  colours inside one `<Text>`) can't be expressed with bare attrs — attrs style
  the *whole* Text.
- **Cause:** `face` merges *under* each span and inner `<Text>` wins on conflict,
  so the only prop-form alternative is nesting `<Text fg=…>` runs as array
  children — verbose for dense one-liners.
- **Workaround:** Keep `face(patch)` (the non-deprecated escape hatch) for
  per-span runtime colours; reserve bare attrs for uniformly-styled nodes.
- **Suggested fix:** Document this split explicitly: "uniform style → bare attrs;
  per-span/dynamic → `face()`." Right now "use `<Text fg=… bold>`" reads as
  *always*, which is impossible for the common multi-colour status line.

### 3. Signals start at their initial value — every thunk runs once on empty
- **Symptom:** First frame throws reading a field off a `null`/`[]` signal.
- **Cause:** Producers (`from`) don't run until watched; the UI renders once
  before data lands. (Documented as gotcha 11 — listed here because it bit anyway
  and is the single most common crash-on-startup.)
- **Workaround:** Guard every render thunk (`x?.field`, `if (!data) return …`).
- **Suggested fix:** Nothing actionable beyond docs; a `from(producer, initial,
  {placeholder})` that suspends children until first emit would remove the class.

### 16. A text leaf wears its CONTAINER's `break`, not the `<Text>`'s **[silent]**
- **Symptom:** `<Box {...tip}><Text break="none">{thunk}</Text></Box>` wrapped a
  one-line status, but at narrow widths the text **word-wrapped and bled
  vertically** into the rows below — garbled overlap, not clipping.
- **Cause:** A container promotes a child run to a text leaf "wearing the
  *container's* `break`" (`module.js` `leafOf`/`container`). The wrapper `<Box>`
  had no `break`, so it defaulted to word-wrap — the inner `<Text break="none">`
  was ignored for wrapping. Nothing warns; it only shows when the box is forced
  narrow.
- **Workaround:** Put `break="none"` on the **Box**, not (only) the `<Text>`; add
  `overflow="hidden"` on the row so residual overflow clips instead of bleeding.
- **Suggested fix:** Make `<Text break>` authoritative for its own run, or
  document loudly that `break`/`overflow` are *container* concerns (the API note
  says so in passing, but the failure mode — vertical bleed — is non-obvious).

### 21. A function `bg` (the `(x,y,w,h)=>color` shader) silently doesn't paint **[silent]**
- **Symptom:** `<Box bg={(x,y,w,h)=>...}/>` rendered with **no fill** — the cells
  kept the surface color underneath, as if `bg` were absent. No error. A static
  string `bg` (incl. 8-digit `#RRGGBBAA` rgba) on the same box paints fine.
  Wanted a 1-col scrollbar whose thumb/track varied by row via the shader; the
  column stayed the panel color (verified by reading the captured `48;2;r;g;b`).
- **Cause:** Unconfirmed — `props()` passes a function `bg` through as a raw
  shader fn (not unwrapped like a signal), but the paint pass doesn't appear to
  invoke it (or expects a different arity/return). The docs advertise
  `bg: color | (x,y,w,h)=>color`, so this is a doc-vs-behavior gap at minimum.
- **Workaround:** Don't compute a per-cell fill via the shader. Build the
  gradient/segments from real boxes instead — wssnoop's overlay scrollbar is
  three stacked boxes with `fr` weights (before/thumb/after) so it flexes to the
  container's real height, each with a plain string `bg`. Static rgba strings
  composite correctly over text (a translucent bg dims the glyph beneath), which
  is the whole reason the shader wasn't needed.
- **Suggested fix:** Either make the shader form actually paint, or drop it from
  the `bg` docs/types so callers don't reach for it.

### 20. A `CellBuffer` is not occluded by boxes drawn over it **[silent]**
- **Symptom:** An opaque, higher-`z` `Box` (with `bg` + `border`) placed over a
  `CellBuffer` does **not** hide it — the buffer's glyphs bleed through the
  panel's empty cells. An overlay panel laid over a sparkline shows the bars
  *interleaved with the panel's own text* (`▀▀⊙ focus▀▀● live`). Reproduced
  minimally: a `bg:"#11161f"` bordered box over a `▀`-filled buffer renders
  `│OPAQUE PANEL▀▀▀▀▀▀│` — the border + text win, the interior bg does not.
- **Cause:** The renderer composites `CellBuffer` planes in a pass that a box's
  background fill doesn't clear. The rule observed: a **non-space glyph** at
  higher z wins (panel text occludes), but a **space** at higher z is treated as
  transparent, so the buffer's glyph below shows through. A `bg` color is not a
  glyph, so it never occludes the buffer.
- **Workaround:** Don't rely on z-order to hide a buffer. Blank the buffer
  itself (write `0x20` spaces) when it should be hidden — e.g. wssnoop blanks the
  table's row/group sparklines while the inspector overlay is open, keeping only
  the toolbar's bar (which is never covered). Alternatively, don't render the
  buffer's subtree at all while it's occluded.
- **Suggested fix:** Composite buffer planes within the normal z-stack so an
  opaque box's `bg` clears the cells beneath it (or expose an `opaque`/clear flag
  on the covering box).

---

## Runtime / isolate

### 4. A hard V8-worker death is uncatchable and paints over the screen **[uncatchable]**
- **Memory cause FIXED on `ben/daemon-fixes`:** the `<1 min under load` death
  was memory growth, now addressed — V8 GC never finalized for a timer-only TUI
  so old-gen climbed to the ceiling (`22e05828` pump foreground tasks), and the
  signal graph retained every unwatched sink (~33 MiB/min leak, `5c621ce7`).
  Heap exhaustion is now a clean force-terminate + dispose (`78a7d6dc`,
  `8ee4f26d`) rather than a hard worker death. (Re-verify under churn on the
  rebuilt daemon — see the resolved note at the end.)
- **Residual (still open):** a *genuine* native fault is still uncatchable —
  there's no global `unhandledrejection` / `onerror` hook, so JS never sees it
  and the watchdog respawn leaves a torn alt-screen. (See gotcha 12 for the
  *catchable* sibling.)
- **Workaround:** Catch at the two boundaries you own (`mount()` try/catch →
  BSOD; wrap timer/subscription callbacks).
- **Suggested fix:** Expose an opt-in `yeet.onWorkerFault(cb)` (even
  best-effort, fired by the watchdog before respawn) so a script can repaint a
  crash banner instead of leaving a torn alt-screen. At minimum, restore the
  cursor/alt-screen on respawn.

### 5. Redirecting stdout removes the `tty` global **[silent]**
- **Symptom:** `yeet run … > out.log` → `ReferenceError: tty is not defined`,
  far from the redirect that caused it.
- **Cause:** `tty` is only injected when stdout is a pty. Redirecting (to tee
  logs during a soak) drops it.
- **Workaround:** Never redirect a TUI script's stdout. Redirect *stderr* only;
  watch the daemon log for the rest.
- **Suggested fix:** Still inject a `tty` shim when stdout isn't a pty (no-op
  draws, real `tty.on` for input), or throw an explanatory error at startup:
  "tty unavailable: stdout is not a terminal (did you redirect it?)".

### 6. No `Intl` / `TextDecoder` / `TextEncoder`
- Documented (gotcha 1) but still the first wall every formatting/decoding task
  hits. `toLocaleString`, `localeCompare`, `Intl.*`, `new TextDecoder()` all
  throw. Hand-roll everything. *Suggested fix:* ship a minimal `TextDecoder`
  (`utf-8` at least) — byte→string is needed by virtually every BPF script.

---

## BPF

### 7. Single-program `bpftool gen object` silently captures nothing **[silent]**
- **Symptom:** An egress-only object built with one program (`-DEGRESS_ONLY`,
  only `probe_ssl_write`) attached fine and reported **0** events. The
  multi-program object from the same source captures egress correctly.
- **Cause:** Appears to be a relocation defect when `bpftool gen object` links a
  single program — the ringbuf map/program wiring comes out inert. No load
  error, no attach error, just silence.
- **Workaround:** Keep all programs in one object; filter in-kernel instead of
  building per-mode objects.
- **Suggested fix:** Investigate the single-program link path; at minimum surface
  a load-time warning when a bound map has no contributing program.

### 8. `.bind()` options are top-level; nesting fails silently **[silent]**
- Documented, repeated here because it's *silent*: `btf_struct`, `capacity`, etc.
  nested under an `opts` key are ignored with no error. *Suggested fix:* reject
  unknown top-level keys / warn on an `opts` object.

### 9. `__u64` map fields ↔ BigInt asymmetry
- Ringbuf `__u64` arrive as BigInt (→ `NaN` the moment they touch `Number`
  math); writes need `BigInt(...)`; smaller ints take plain numbers. Documented
  (gotcha 2) but a perennial source of `NaN`. The CLAUDE.md trick — a
  BigInt-flagging `JSON.stringify` replacer in the probe self-test — should be
  the *default* dump helper, not a tip.

### 10. Big graph queries can wedge the daemon for all scripts
- A pathological query (full memory maps of a huge process) hangs not just the
  caller but every `yeet run` until the daemon restarts. *Workaround:* race every
  query against a timeout. *Suggested fix:* per-query server-side deadline +
  cancellation, so one bad query can't take the daemon hostage.

### 18. `proc(pid)` *throws* for a dead pid instead of returning null **[silent]**
- **Symptom:** Liveness-checking a stopped process with `{ proc(pid: N) { exe } }`
  rejects the whole query: `ServerError "File not found: /proc/N"` — and one bad
  pid kills the batch.
- **Cause:** `proc(pid)` resolves straight off `/proc/<pid>` and surfaces the
  ENOENT as a GraphQL error, not a nullable result.
- **Workaround:** Don't probe pids individually for liveness — query
  `{ procs { stat { pid } } }` once and treat any known pid absent from that set
  as exited. (This is what wssnoop's procinfo liveness poll does.)
- **Suggested fix:** Make `proc(pid)` nullable (return null for a gone pid) so a
  liveness check is a null-test, not exception handling.

### 19. Repeated crash-loop / `kill -9` of jails can wedge the worker manager
- **Symptom:** After many fast `yeet run` crashes + `sudo kill -9 'yeetd: jail'`
  cycles (stress-testing), the V8 worker *manager* itself wedged — `/v8/isolates`
  returned `500` for **every** script (even a no-graph `console.log`), not just
  graph ones. Only a full `yeetd` restart recovered it.
- **Cause:** Unclear — the watchdog respawn/backoff path seems to get stuck when
  jails are force-killed faster than it can reconcile.
- **Workaround:** Don't `kill -9` jails in a tight loop; let scripts exit (or use
  `--secs`). To recover: restart the daemon (it re-attaches). Note the daemon is
  launched detached (parent = init), so a kill needs a manual relaunch — the
  stdout/stderr redirect is opened by the *launching user*, not root.
- **Suggested fix:** A `yeet ps` / `yeet kill`-by-jail and a supervised daemon so
  recovery doesn't mean hand-relaunching a root process.

---

## Tooling / run mechanics

### 12. Bare `--bin node` won't attach; needs an absolute path
- **Symptom:** `Could not resolve uprobe attach target: node`.
- **Cause:** uprobe attach doesn't `$PATH`-resolve the binary.
- **Workaround:** Pass `$(command -v node)` (an absolute path). For statically
  linked SSL (node), the binary *is* the exe; for dynamic, it's `libssl.so`.
- **Suggested fix:** `$PATH`-resolve a bare name, or say so in the error
  ("expected an absolute path or a library on the loader path").

### 13. The daemon log is binary **[missing-stair]**
- `/tmp/yeetd.log` is not plain text; `cat`/`tail` give mojibake. You need
  `sudo strings /tmp/yeetd.log`. Nothing tells you this. *Suggested fix:* a
  `yeet logs [-f]` subcommand, or write a text log.

### 14. The built bundle (`src/index.jsx`) shadows source **[silent]**
- The entry ladder prefers `src/index.jsx` (the esbuild bundle) over
  `src/main.jsx`. A stale bundle silently runs instead of your edits when you
  `yeet run .`. We detect bundled-vs-source by filename
  (`import.meta.filename.endsWith("/index.jsx")`) to fix the `../bin` vs
  `../../bin` path — itself a smell. *Suggested fix:* `yeet run <file>` should
  honour the named file; warn when a bundle is newer/older than its source.

### 15. Login shell is fish in the test VM — `VAR=val cmd` is silently ignored
- Not a yeet bug, but it broke every soak invocation (`RECYCLE=8000 ./run.sh`
  ran with `RECYCLE` unset, no error). Mentioned so the demo harness uses
  `env VAR=val` or real flags. We moved the demo knobs to CLI flags so the shell
  can't eat them.

---

## What we changed in wssnoop because of the above
- Per-event memory pressure (#4) drove the <1 min crash: smaller capture chunk,
  CellBuffer sparklines, O(1) message ring, json-on-demand. This made the
  **calm** demo stable (verified: renders + 0 deaths over a soak).
- Dropped egress-only mode (#7) — the in-kernel focus filter covers it.
- Demo knobs are CLI flags, not env vars (#15).
- Migrated combinators → `<Text>` attrs / `face()` (#1) where the style is uniform.
- Automatic bin discovery: `--bin node` (bare) or `--pid N` resolves the SSL
  binary from the process graph (#12).

## Resolved: the memory-pressure death (was: "hard death under churn")
The churn death — `./demo/run.sh start --recycle 6000` killing the worker ~6–8 s
in — traced to two daemon bugs now fixed on `ben/daemon-fixes`: V8 GC never
finalized for a timer-only TUI so old-gen climbed to the heap ceiling
(`22e05828`), and the signal graph retained every unwatched sink, leaking
~33 MiB/min (`5c621ce7`). Heap exhaustion is now a clean force-terminate +
dispose (`78a7d6dc`, `8ee4f26d`) rather than a hard worker death. The wssnoop
mitigations (smaller capture chunk, CellBuffer sparklines, O(1) message ring,
json-on-demand) still help but were treating a symptom.
**To do:** re-run the `--recycle 6000` churn soak on the rebuilt daemon; if it
holds, the residual of #4 is only the *genuine* native-fault case (no in-JS
hook), and this note can go entirely.
