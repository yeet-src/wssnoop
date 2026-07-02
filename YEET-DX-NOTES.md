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

### 24. A signal read in the JSX *body* binds at mount; a later identity swap is missed **[silent]**
- **Symptom:** the ALL-row aggregate `<Agg hist={ghist.get()} …/>` froze at
  `↑0B ↓0B` while every per-process header — fed the same kind of live hist —
  climbed normally. The figure never moved even under heavy traffic.
- **Cause:** `ghist` is `computed(() => global.get().hist)`, and the `global`
  signal starts on a *placeholder* `{ hist: emptyHist, … }`, swapping to the
  registry's real hist only on the first heartbeat publish. Reading `ghist.get()`
  in the JSX body (not inside a thunk) captures whatever it is at mount — the
  empty placeholder — and never re-reads. The per-process headers worked only
  because their hist object *is* the live one from the first render. The usual
  "live objects mutate in place, so reading once is fine" intuition holds for a
  stably-identified object but breaks the moment a signal *replaces* the object.
- **Workaround:** read the signal inside a thunk child so it re-binds on the
  swap: `{() => <Agg hist={ghist.get()} …/>}`. Deduped by the `computed`, it
  re-mints only on the single identity change.
- **Suggested fix:** nothing to fix in the engine — it's the documented thunk
  rule — but the docs frame it as "plain value vs thunk"; a line noting that *a
  signal read in the body is a plain value* (frozen at mount even when it's an
  object later replaced) would save the debugging. Or: seed session signals with
  the real long-lived objects up front so identity never swaps (state.js could
  hand out the registry's `globalHist` in the initial `global` value).

---

## Runtime / isolate

### 27. `yeet.exit()` during a pending top-level await paints a spurious error **[cosmetic]**
- **Symptom:** a self-test that parks on `await new Promise(() => {})` and later
  calls `yeet.exit(0)` from a timer exits, but the daemon then paints
  `V8_EVALUATE_ERROR — Module evaluate failed: pending module evaluation should
  not be discarded` over the clean output. The real output printed fine; the RC
  is nonzero purely from this.
- **Cause:** exiting while the module's top-level evaluation promise is still
  pending; the isolate tears down mid-eval and reports the discarded evaluation.
- **Workaround:** cosmetic — ignore it, or resolve the parking promise before
  exiting instead of calling `yeet.exit()` under it.
- **Suggested fix:** treat an explicit `yeet.exit()` as a clean shutdown that
  cancels (not errors) a pending top-level evaluation.

---

## BPF

### 26. `start()` rejects an object if any uprobe program lacks attach opts **[doc-gap]**
- **Symptom:** loading the tap object to use *only* its kernel-global probes
  (bind the discovery ringbuf, skip the SSL uprobe `attach()` calls) fails at
  `start()`: `Invalid attach opts for program 'probe_ssl_write': No attach opts
  provided`. There's no way to attach a subset of an object's programs.
- **Cause:** kprobe/fentry/fexit programs auto-attach from their ELF section,
  but a uprobe can't (it has no target), so every uprobe program in the object
  is mandatory — `start()` won't load the object while one is unattached.
- **Workaround:** put kernel-global-only work in its **own** object. wssnoop's
  layer-1 discovery (`discover.bpf.c` → `bin/discover.bpf.o`, tcp_connect +
  tcp_close) is a separate object from the SSL tap for exactly this reason, so it
  loads with no uprobe to satisfy. (A single-unit object with 2 programs loads
  and captures fine — the #7 single-*program* relocation issue did not recur.)
- **Suggested fix:** allow attaching a subset (skip/disable an unattached uprobe
  program) instead of rejecting the whole object, or document that a mixed
  uprobe + kernel-global object is all-or-nothing.

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

### 25. The debug harness `key` can't send named keys (Escape/Enter) — typed literally **[missing-stair]**
- **Symptom:** `wss-harness.sh key Escape` didn't clear the search / back out; it
  *appended the letters* "Escape" to the query box. With a `$.field` query live
  that then matched nothing, so the screen showed a puzzling `0/N` instead of a
  cleared filter — looked like a reactivity bug, wasn't.
- **Cause:** the harness sends every key with `tmux send-keys -l` (literal), so
  tmux key *names* (`Escape`, `Enter`, `Up`) come through as their characters,
  not the keypress. `q` "worked" only because it's a literal char.
- **Workaround:** send named keys with a raw tmux call minus `-l`:
  `tmux -L wssdbg -f /dev/null send-keys -t wss Escape`. The app routes these via
  `e.code` (`Escape`/`Enter`/`Backspace`), so they need the real key event.
- **Suggested fix:** give `wss-harness.sh` a `keyname <name>` subcommand (or
  auto-detect known tmux key names) that omits `-l`, so back-out / confirm /
  arrow flows are testable headlessly like clicks and chars already are.

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
