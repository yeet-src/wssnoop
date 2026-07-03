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

### 29. Map `.bind()` kind spellings are underscore/compact, not the hyphens the docs show — and an unknown kind is silently unbound **[silent]** **[doc-gap]**
- **Symptom:** `.bind("focus_pids", { kind: "hash-map" })` (the spelling in
  CLAUDE.md's kind list) loaded fine, but the first `HashMap.update` rejected
  with `No map service for map: focus_pids`. The map was never served.
- **Cause:** the daemon's bind-kind parser (`translate_bind_spec`) accepts
  `hashmap | hash_map | hash` — **not** `hash-map`. The hyphenated forms in the
  docs (`hash-map`, `lru-hash-map`, …) match the *module* names
  (`yeet:bpf:hash-map`) and the JS class import, but not the bind `kind` string.
  Worse, an unrecognized kind doesn't fail `start()` — the map is just silently
  not registered as a KV service, so the failure only surfaces later at the
  first map op, far from the actual mistake.
- **Workaround:** use `kind: "hash_map"` (and `lru_hash_map`, `percpu_hash_map`,
  `bloom` / `bloom_filter`, `lpm` / `lpm_trie`). `ringbuf`, `array`, `data`
  match the docs.
- **Suggested fix:** accept the hyphenated spellings as aliases (they're the
  documented ones), or reject an unknown/aliased bind kind at `.start()` with a
  clear error naming the map, instead of a silent no-service that only trips at
  first use.

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

### 28. No way for a script to hand back a re-invocation command on exit **[missing-stair]**
- **Symptom:** an interactive session discovers/selects its target (here, the
  resolved `--bin` path and/or `--pid`), but that knowledge dies with the
  process. The next launch rediscovers from scratch; there's no "here's the
  exact command to skip the picker next time."
- **Desired:** like `claude --resume <id>`, a script should be able to emit a
  suggested re-invocation (`yeet run <path> --bin <resolved> [--pid N]`) that the
  CLI surfaces on exit, so a target chosen once is replayable non-interactively
  (a shell alias, a script, CI). This is general *routing* — a script computing
  its own canonical next invocation, not wssnoop-specific.
- **Why the obvious approach fails:** `console.log` can't be the vehicle. It
  goes to the daemon's (binary) log, not the terminal the user launched from
  (gotcha 8), and the TUI owns the alt-screen until teardown — so a script has
  no way to leave a "run this next" line on the real stdout.
- **Suggested fix:** a first-class runtime affordance — the script registers the
  suggestion (e.g. `yeet.suggestReinvoke(argv)`) and the `yeet` CLI, which owns
  the real stdout and outlives the daemon session, prints it after restoring the
  terminal. Not `console.log`, not a stdout convention.

---

## Profiling language TLS runtimes (notes for a possible yeet helper)

Where the plaintext of an in-process TLS connection crosses a boundary you can
uprobe, per runtime. wssnoop hardcodes this per language; a general yeet
"inspect runtime X" helper could own it. All validated on arm64 (aarch64),
go1.24 / rustls 0.26 / OpenSSL 3 / CPython 3.13, kernel 6.x. Register notes are
arm64; x86-64 differs (args RDI/RSI/RDX, return RAX).

### OpenSSL family (node static, Python/Ruby dynamic, Rust native-tls, C/C++)
- Hook `SSL_write`/`SSL_read` **and** `SSL_write_ex`/`SSL_read_ex`. This bit us:
  Python captured *nothing* until we added the `_ex` pair — CPython's `_ssl`
  calls `SSL_read_ex`/`SSL_write_ex` (OpenSSL 1.1.1+), never the classic API.
  node/Rust-openssl/uSockets use the classic API. So a general OpenSSL profiler
  must hook both families.
- write: plaintext in the buffer arg at entry. read: buffer filled by return —
  classic returns the byte count, `_ex` reports it via `size_t *readbytes` (deref
  at the uretprobe). The `SSL*` (arg0) is a stable per-connection id.
- Symbol location: a mapped `libssl` (dynamic) or the exe itself (static —
  node/deno/bun bake it in). The graph exposes maps + exe, so this is decidable
  without symbols, *except* a static exe under an unknown name reads as opaque.
- `_ex` is absent from BoringSSL and pre-1.1.1 OpenSSL, and `start()` rejects an
  object with any unattached uprobe (#26), so the two families must be separate
  loadable objects attached best-effort — never folded into one.

### Go crypto/tls (gorilla, net/http, anything on the stdlib)
- No OpenSSL symbols at all. Hook `crypto/tls.(*Conn).Write` and `.Read` by
  symbol — present in `.symtab` unless the binary is stripped, and the names
  carry **no hash** (stable across builds, unlike Rust).
- Register ABI (Go 1.17+): a method's receiver is arg0, a `[]byte` passes as
  three words. On arm64 that lands X0=recv, X1=ptr, X2=len — the same registers
  the C ABI uses, so `BPF_KPROBE` PARMs read them directly. Return value in X0.
- Two Go-specific hazards, both real:
  1. **Key entry↔return by goroutine id, not thread id.** `Read` blocks on the
     network and Go can resume the goroutine on a different OS thread, so the
     return fires on a different tid than entry. `goid` is stable. The g pointer
     is in X28 (arm64); `goid` sits at a fixed offset in `runtime.g` (0xa0 for
     go1.24 — version-specific, pull from DWARF; see demo/goworker/extract_goid).
  2. **uretprobe vs moving stacks.** Go relocates goroutine stacks, which can
     corrupt a uretprobe trampoline. In practice a plain uretprobe on `Read`
     worked on go1.24 + kernel 6.x (worker stayed up, reads decoded clean), but
     the safe general technique is uprobes placed at the function's `RET`
     offsets (arm64 `ret` = `0xd65f03c0`; scan the symbol's bytes). The daemon's
     `symbol + offset` uprobe supports exactly this.

### rustls (tokio-tungstenite, any pure-Rust TLS)
- Hookable after all — it *does* keep concrete boundary symbols (they are not
  fully inlined): egress `<rustls::conn::ConnectionCommon<T> as
  ...PlaintextSink>::write(&mut self, buf: &[u8])` (arm64 X0=self, X1=ptr,
  X2=len at entry — validated), ingress
  `rustls::common_state::CommonState::take_received_plaintext` (returns the
  bytes by value → return-ABI capture, harder). `&mut self` is a stable conn id.
- The blocker is naming, not inlining: symbols are mangled *with a codegen hash*
  (`..PlaintextSink$GT$5write17h`**`c274a2dce4faded2`**`E`) that **changes every
  build**, so you can't hardcode the name. libbpf resolves it daemon-side from
  the string, so you only need to hand it the current mangled name — which means
  resolving it per-target (nm/`.symtab`). Rust threads don't migrate mid-call,
  so pid_tgid keying is fine and uprobe/uretprobe are safe.

### What a general yeet helper would want
- **Symbol resolution that tolerates Rust hashes** — match by demangled name or
  a `..write17h`-style prefix, so a caller needn't know the per-build hash. This
  is the single thing that would turn rustls from "targeted" into "general".
- **Attach-at-all-RETs of a symbol** — scan the symbol's bytes for the arch
  `ret` opcode and attach at each offset; the safe way to capture a Go return
  without uretprobe. (`symbol + offset` already exists; this would automate the
  offset discovery.)
- **Per-arch register reads from a uprobe** — g (X28), the sret pointer (X8),
  raw argN — for ABI-specific extraction (goid, Rust by-value returns).
- **Offset extraction from DWARF/pclntab** — `runtime.g.goid`, struct field
  offsets — so version-specific constants aren't hand-maintained.

## What we changed in wssnoop because of the above
- Per-event memory pressure (#4) drove the <1 min crash: smaller capture chunk,
  CellBuffer sparklines, O(1) message ring, json-on-demand. This made the
  **calm** demo stable (verified: renders + 0 deaths over a soak).
- Dropped egress-only mode (#7) — the in-kernel focus filter covers it.
- Demo knobs are CLI flags, not env vars (#15).
- Migrated combinators → `<Text>` attrs / `face()` (#1) where the style is uniform.
- Automatic bin discovery: `--bin node` (bare) or `--pid N` resolves the SSL
  binary from the process graph (#12).
