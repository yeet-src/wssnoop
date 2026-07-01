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

### 2. Multi-span styled text has no clean prop form
- **Symptom:** A line like `[fg(out)("↑"), fg(dim)(n), fg(role)(name)]` (per-span
  colours inside one `<Text>`) can't be expressed with bare attrs — attrs style
  the *whole* Text.
- **Cause:** `face` merges *under* each span and inner `<Text>` wins on conflict,
  so the only prop-form alternative is nesting `<Text fg=…>` runs as array
  children — verbose for dense one-liners.
- **Workaround:** Keep `face(patch)` (the non-deprecated escape hatch) for
  per-span runtime colours; reserve bare attrs for uniformly-styled nodes.
- **Suggested fix:** Nested <Text> should work to fix this... actually,
wait, shouldn't this *already work*?? Verify it!
- **Fixed:** Verified already working — nested `<Text fg=…>` array children
  give per-span colours, each painting its own cell. Locked in with a
  regression test (`a89f10d2`, branch `ben/dx-fixes-for-wssnoop`).

### 16. A text leaf wears its CONTAINER's `break`, not the `<Text>`'s **[silent]**
- **Symptom:** `<Box {...tip}><Text break="none">{thunk}</Text></Box>` wrapped a
  one-line status, but at narrow widths the text **word-wrapped and bled
  vertically** into the rows below — garbled overlap, not clipping.
- **Cause:** A container promotes a child run to a text leaf "wearing the
  *container's* `break`" (`module.js` `leafOf`/`container`). The wrapper `<Box>`
  had no `break`, so it defaulted to word-wrap — the inner `<Text break="none">`
  was ignored for wrapping. Nothing warns; it only shows when the box is forced
  narrow.
- **Suggested fix:** Make `<Text break>` authoritative for its own run
- **Fixed:** `break`/`overflow` now split off the span face and ride the run to
  the leaf it's promoted to, winning over the container's default (`f89eed21`).

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
- **Suggested fix:** Fix the shader functions, they seem to just be
broken. Make sure there's a test so this doesn't regress again.
- **Fixed:** Verified painting — a function `bg` reaches paint via `common()`'s
  `color()` coercion and `baked()`, so it varies per cell (incl. the one-col
  scrollbar). Locked in with a regression test (`81c23fa2`). If your build
  showed no fill, it predates the wiring; rebuild the daemon.

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
- **Suggested fix:** Composite buffer planes within the normal z-stack so an
  opaque box's `bg` clears the cells beneath it (or expose an `opaque`/clear flag
  on the covering box).
- **Fixed:** `paint`'s bg fills now occlude — a fully-covered opaque cell has its
  glyph cleared; translucent/faded fills still only veil. The imperative
  `tint`/`Buffer.tint` (veil-only) semantics are unchanged (`f584eaa5`).

### 22. A bare inline thunk child re-mounts its subtree every render pass **[silent]**
- **Symptom:** A conditional child written as a bare thunk —
  `{() => cond.get() ? <Panel/> : null}` — re-creates `<Panel>` on *every*
  render pass of its container (≈ each heartbeat here), even when `cond` is
  unchanged. Per-node local state is silently reset on that cadence: a
  `setHover` boolean never sticks, a `signal()` declared in the component body
  resets ~2×/s. Confirmed with a module-level mount counter (1 → climbing 2/s).
- **Cause:** No stable node identity / reconciliation (it's signals, not a
  vdom). A bare thunk is re-invoked by the framework whenever its container
  re-renders and mints a fresh element each time; the old node (and its local
  signals) is discarded.
- **Workaround:** Memoize the node in a `computed` so it recomputes only when a
  *read* signal changes, keeping the element reference stable:
  `const panel = computed(() => cond.get() ? <Panel/> : null)` then `{panel}`.
  The subtree then mounts once and its own internal thunks drive liveness.
  (wssnoop did this for the inspector; its buttons' local hover now persists,
  removing a module-keyed-hover workaround.) For state that must outlive a
  genuine remount, hoist it to a module-level signal keyed by identity.
- **Suggested fix:** Either memoize bare thunk children by referential equality
  of their result, or document that conditional/dynamic children belong in a
  `computed`, not a bare thunk.
	(Yeah thunks -> computeds should always be memoized, if i'm understanding this issue right -- Ben)
- **Fixed:** Bare thunk children (the array-child shape JSX gives multiple kids)
  are now memoized to a stable `computed` keyed by fn identity, so the subtree
  mounts once and its local signals persist across sibling re-projection
  (`32ebe54a`).

### 23. A fit-width flow row omits `gap` from its own width, clipping the tail **[silent]**
- **Symptom:** A `<Box direction="row" gap=N>` sized `fit` under-reports its width
  by `N*(children-1)`, so `overflow:hidden` clips the last child(ren). Worse next
  to a `1fr` spacer, which over-grows into the phantom free space and shoves the
  row off the right edge. Hit in wssnoop's toolbar: the `search sort role idle
  rows ‹ win ›` cluster clipped `rows`/`win`/`?` at every width.
- **Cause:** Pass-1 intrinsic measure folded children with a gap-less sum while
  pass-2 layout inserts the gap, so a fit container's width = Σchildren but its
  content occupies Σchildren + gap·(n−1).
- **Workaround:** Moved the `?` button left of the `1fr` spacer, where layout is
  stable.
- **Fixed:** Source fixed in yeet master (`d41258ca`, "Handle gap in a tui layout
  intrinsic computation") — flow mode folds with gaps; `overlap` still ignores
  gap. Regression test at `layout/module.test.js` ("A fit stack reserves gap
  between children, so its last child fits"). NB the dev VM daemon must be
  rebuilt to carry it — a version-string bump does not imply the commit is in the
  build. See `~/notes/yeet-tui-flow-gap-intrinsic-width.md`.
- **Update 2026-07-01 (daemon now on 0.19.5 with the fix, verified live):** the
  gap fix works for a plain fit row (`clip.jsx`: all gaps now fit). BUT the
  toolbar still clips: a **fit cluster beside a `1fr` spacer** under-measures
  independently of gap — the `1fr` over-grows into the phantom slack and shoves
  the cluster off the right edge (reproduced live at 200 AND 280 cols, static or
  thunk widths, gap-fix present). So this is a *second, still-open* layout bug;
  the `?` button stays left of the spacer. Workaround if you need the cluster
  right-aligned and complete: give it an explicit `width` (a fixed-width sibling
  of a `1fr` is measured correctly) rather than relying on `fit`.

---

## Runtime / isolate

### 6. No `Intl` / `TextDecoder` / `TextEncoder`
- Documented (gotcha 1) but still the first wall every formatting/decoding task
  hits. `toLocaleString`, `localeCompare`, `Intl.*`, `new TextDecoder()` all
  throw. Hand-roll everything. *Suggested fix:* ship a minimal `TextDecoder`
  (`utf-8` at least) — byte→string is needed by virtually every BPF script.
- **Fix**: Make sure yeet:text is at least minimally documented in ../docs.
- **Fixed (docs):** `yeet:tui:text` now documented in ../docs — measurement,
  wrapping/truncation, and `toUTF8`/`toUTF16`/`toUTF32` encoders; the runtime
  reference's TextEncoder/TextDecoder note points there (docs `d369eb8`). The
  runtime still ships no `TextDecoder`; the encoders cover string ↔ bytes.

---

## BPF
	- DEFERED, don't work on this section rn.

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
DEFERRED

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
