#!/usr/bin/env bash
# wssnoop demo — one command, no browser.
#
# Launches several worker processes (distinct identities), each holding multiple
# live wss:// connections (coinbase + kraken + polymarket) and continuously
# churning subscriptions, so wssnoop has rich multi-process, multi-connection,
# bidirectional traffic to show immediately.
#
# Run it inside the yeet VM (where node + yeet live). Attaches by --bin <node>
# with no --pid, so wssnoop sees every worker — current and future.
#
# NB: do NOT redirect wssnoop's stdout (`… > out.log`) — yeet only injects the
# `tty` global when stdout is a pty, so a redirect makes the script die with
# "tty is not defined". Watch the daemon log instead (see YEET-DX-NOTES.md #5).
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEMO_DIR/.." && pwd)"
cd "$DEMO_DIR"
# shellcheck disable=SC1091
. "$HOME/.nvm/nvm.sh" 2>/dev/null || true

ROLES=(order-router md-gateway risk-engine)
# One role runs on a SECOND runtime (Python, via worker.py) instead of node, so
# the demo shows two distinct SSL binaries: node (static — probe the exe) and
# python3 (dynamic — probe the mapped libssl). This is what exercises
# multi-runtime binary discovery. Python's feeds skip poly (its worker has no
# REST-catalog prime step).
PY_ROLE=risk-engine

usage() {
  cat <<'EOF'
wssnoop demo — drive live wss:// traffic for wssnoop to inspect.

USAGE
  ./demo/run.sh <command> [options]

COMMANDS
  start            start the worker processes; print the wssnoop attach command
  attach           start the workers AND launch wssnoop attached to them
  docker           run workers INSIDE a docker container and attach wssnoop to
                   it — demonstrates the container nesting tier (needs docker)
  go               build + run a gorilla/websocket worker (Go crypto/tls) and
                   attach wssnoop — decodes pure-Go TLS (needs go)
  rust             build + run a tokio-tungstenite (rustls) worker and attach
                   wssnoop, auto-resolving rustls' symbols (needs cargo)
  stop             stop the demo workers (and the demo container) — leaves any
                   running wssnoop alone
  reap             kill leftover wssnoop isolates from a crashed terminal
                   (NB: also kills a wssnoop you're actively viewing — quit that
                   with `q`, not this)
  status           show which workers are running
  help             show this help (also shown with no command)

OPTIONS (apply to start / attach; flags, so fish-safe)
  --recycle MS     recycle each connection every ~MS (jittered ×1–2); 0 = never
  --no-deflate     disable permessage-deflate on the workers
  --abrupt         recycle by terminate() (no CLOSE/shutdown) — exercises resets
  (Env vars RECYCLE / NODEFLATE / ABRUPT still work as fallback defaults.)

EXAMPLES
  ./demo/run.sh attach                  # the one-liner demo
  ./demo/run.sh start --recycle 6000    # background traffic with reconnect churn
  ./demo/run.sh status
  ./demo/run.sh stop
EOF
}

# A bare-verb subcommand plus --options. Options default from the environment
# (back-compat). The command is the first verb seen; no command ⇒ help.
CMD=""
RECYCLE="${RECYCLE:-0}"
NODEFLATE="${NODEFLATE:-}"
ABRUPT="${ABRUPT:-}"
set_cmd() { [[ -z "$CMD" ]] || { echo "conflicting commands: $CMD and $1" >&2; exit 2; }; CMD="$1"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    start|attach|docker|stop|status|reap|go|rust) set_cmd "$1" ;;
    help|--help|-h) CMD="help"; break ;;
    --recycle)    RECYCLE="$2"; shift ;;
    --recycle=*)  RECYCLE="${1#*=}" ;;
    --no-deflate) NODEFLATE=1 ;;
    --abrupt)     ABRUPT=1 ;;
    *) echo "unknown argument: $1" >&2; echo "try: ./demo/run.sh help" >&2; exit 2 ;;
  esac
  shift
done

NODE="$(command -v node 2>/dev/null || true)"
YEET="$(command -v yeet 2>/dev/null || echo /opt/yeet/crates/target/release/yeet)"
CTR_NAME="wssnoop-demo"
PIDFILE="/tmp/wssnoop-demo.pids" # the exact worker pids this script started

# Docker usually needs sudo here (the socket is root:docker); pick whichever
# invocation can reach the daemon. Sets $DKR for use as `$DKR <args>`.
DKR=""
have_docker() {
  [[ -n "$DKR" ]] && return 0
  command -v docker >/dev/null 2>&1 || return 1
  if docker info >/dev/null 2>&1; then DKR="docker"; return 0; fi
  if sudo docker info >/dev/null 2>&1; then DKR="sudo docker"; return 0; fi
  return 1
}

# Reap *stale* wssnoop isolates: `yeet run` outlives its client, so a
# force-closed terminal (Ctrl-C the terminal, not `q`) can leave a daemon-side
# isolate running its BPF tap; the zombie then starves a fresh attach until it
# hangs at "starting…". This is EXPLICIT only (the `reap` command) — it can't
# tell a zombie from a live viewer, so we never run it from stop/start/attach,
# which would kill the wssnoop you're watching. Normal teardown is `q`.
reap_jails() {
  "$YEET" ps 2>/dev/null \
    | awk 'NR>1 && $1 ~ /^[0-9]+$/ && /main\.jsx/ { print $1 }' \
    | while read -r id; do echo ">> killing wssnoop isolate $id"; "$YEET" kill "$id" >/dev/null 2>&1 || true; done
}

# True iff $1 is a pid of one of OUR demo workers. worker.mjs sets
# process.title=$role, so a worker's comm is exactly the role name; that's our
# marker. A precise identity check, not a command-line substring match.
is_demo_worker() {
  local c r; c="$(cat "/proc/$1/comm" 2>/dev/null)" || return 1
  for r in "${ROLES[@]}"; do [[ "$c" == "$r" ]] && return 0; done
  return 1
}

# Stop only the demo TRAFFIC — the worker processes and the demo container. It
# deliberately does NOT touch wssnoop isolates (that's the user's viewer; quit
# it with `q`). Use `reap` to clear a leftover viewer from a crashed terminal.
#
# We kill ONLY processes this script started (their pids, in $PIDFILE) and
# re-verify each is still a demo worker before signalling it, so PID reuse can't
# make us kill something else. There is deliberately NO `pkill -f worker.mjs`:
# `-f` matches a substring of EVERY process's full command line, so it would
# also kill the shell running this script, an editor/tmux, or a wssnoop you're
# viewing if any of them merely mentions a worker path — that was the bug. The
# only pattern match kept is `pkill -x <role>` (exact comm, demo-specific names)
# to sweep orphans from a run whose pidfile was lost.
stop() {
  if [[ -f "$PIDFILE" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] && is_demo_worker "$pid" && kill "$pid" 2>/dev/null || true
    done < "$PIDFILE"
    rm -f "$PIDFILE"
  fi
  for r in "${ROLES[@]}"; do pkill -x "$r" 2>/dev/null || true; done
  if have_docker; then $DKR rm -f "$CTR_NAME" >/dev/null 2>&1 || true; fi
}

# Run the demo workers INSIDE one docker container, then attach wssnoop to the
# container's node binary. node statically links its TLS, so we attach to *that*
# binary (the container's own inode), reached from the host as
# /proc/<pid>/root/<node> — wssnoop then sees the container's processes and
# nests them under their container (procinfo reads the cgroup id; the graph's
# docker field resolves the name). Two workers share the one node, so the tier
# reads as: ⬢ wssnoop-demo → edge-proxy / api-gateway → connections.
docker_demo() {
  have_docker || { echo "docker not found or its daemon isn't reachable (install docker + start it)"; exit 1; }
  npm install --no-audit --no-fund >/dev/null 2>&1 || true # ws into demo/node_modules (bind-mounted)
  echo ">> pulling node:22-slim…"; $DKR pull -q node:22-slim >/dev/null
  $DKR rm -f "$CTR_NAME" >/dev/null 2>&1 || true
  local opts="--recycle $RECYCLE ${NODEFLATE:+--no-deflate} ${ABRUPT:+--abrupt}"
  $DKR run -d --name "$CTR_NAME" -v "$DEMO_DIR":/app -w /app node:22-slim sh -c \
    "node worker.mjs --role edge-proxy --feeds coinbase,kraken $opts & \
     node worker.mjs --role api-gateway --feeds poly $opts & wait" >/dev/null
  sleep 2
  local pid nodep
  pid="$($DKR inspect -f '{{.State.Pid}}' "$CTR_NAME")"
  nodep="$($DKR exec "$CTR_NAME" sh -c 'command -v node')"
  echo ">> container '$CTR_NAME' up (host pid $pid); launching wssnoop…"
  cd "$REPO_DIR"
  # No --pid: attach to the container's node inode so BOTH its workers are traced.
  exec "$YEET" run src/main.jsx -- --bin "/proc/$pid/root$nodep"
}

status() {
  local any=0
  for r in "${ROLES[@]}"; do
    # `|| true`: pgrep exits 1 when nothing matches, which under `set -e` +
    # pipefail would otherwise abort the whole script on a down worker.
    local pids; pids="$(pgrep -x "$r" 2>/dev/null | tr '\n' ' ')" || true
    if [[ -n "$pids" ]]; then
      printf "  %-14s up    pid %s\n" "$r" "${pids% }"; any=1
    else
      printf "  %-14s down\n" "$r"
    fi
  done
  if [[ "$any" == 1 ]]; then
    echo ">> attach wssnoop to the node workers (--bin node); $PY_ROLE is python (dynamic libssl):"
    echo ">>     $YEET run src/main.jsx -- --bin ${NODE:-node}"
  else
    echo ">> no workers running — start them with ./demo/run.sh start"
  fi
}

# Go demo: build + run a gorilla/websocket worker (pure-Go crypto/tls, no
# OpenSSL) and attach wssnoop to it. Go symbols are stable, so nothing to
# resolve — wssnoop's Go tap attaches by name automatically.
go_demo() {
  command -v go >/dev/null || { echo "go not found — install golang-go"; exit 1; }
  echo ">> building go worker…"
  (cd "$DEMO_DIR/goworker" && GOFLAGS=-mod=mod go build -o /tmp/go-worker .) || { echo "go build failed"; exit 1; }
  pkill -x go-fanout 2>/dev/null || true; sleep 1
  setsid /tmp/go-worker --role go-fanout --feeds coinbase,kraken --recycle 8000 >/tmp/wssnoop-go.log 2>&1 </dev/null &
  sleep 2
  local pid; pid="$(pgrep -x go-fanout | head -1)"
  echo ">> go-fanout up (pid $pid); launching wssnoop (Go crypto/tls tap)…"
  cd "$REPO_DIR"; exec "$YEET" run src/main.jsx -- --pid "$pid"
}

# rustls demo: build + run a tokio-tungstenite (rustls) worker and attach
# wssnoop to it. rustls' boundary symbols carry a per-build codegen hash the
# isolate can't resolve, so we resolve them here (nm) and hand them in — the
# demo "just works" with no manual step. (Fully dynamic discovery would need a
# daemon-side symbol-by-prefix resolver — see ../COORDINATION.md / YEET-DX-NOTES.)
rust_demo() {
  command -v cargo >/dev/null || { echo "cargo not found — install cargo/rustc"; exit 1; }
  echo ">> building rust worker (rustls)…"
  (cd "$DEMO_DIR/rustworker" && cargo build --release) || { echo "cargo build failed"; exit 1; }
  pkill -x rust-worker 2>/dev/null || true; sleep 1 # free /tmp/rust-worker before copy
  cp "$DEMO_DIR/rustworker/target/release/rust-worker" /tmp/rust-worker
  setsid /tmp/rust-worker --role rust-md --feeds coinbase,kraken --recycle 8000 >/tmp/wssnoop-rust.log 2>&1 </dev/null &
  sleep 2
  local pid wsym rsym
  pid="$(pgrep -x rust-worker | head -1)"
  wsym="$(nm --defined-only /tmp/rust-worker 2>/dev/null | awk '{print $3}' | grep -E 'PlaintextSink.*5write17h' | grep -v vectored | head -1)"
  rsym="$(nm --defined-only /tmp/rust-worker 2>/dev/null | awk '{print $3}' | grep take_received_plaintext | head -1)"
  [ -n "$wsym" ] && [ -n "$rsym" ] || { echo "could not resolve rustls symbols (need nm + an unstripped build)"; exit 1; }
  echo ">> rust-md up (pid $pid); resolved rustls symbols; launching wssnoop…"
  cd "$REPO_DIR"; exec "$YEET" run src/main.jsx -- --pid "$pid" --rust-write "$wsym" --rust-read "$rsym"
}

case "$CMD" in
  ""|help) usage; exit 0 ;;
  status)  status; exit 0 ;;
  stop)    stop; echo "stopped demo workers"; exit 0 ;;
  reap)    reap_jails; echo "reaped leftover wssnoop isolates"; exit 0 ;;
  go)      go_demo ;;
  rust)    rust_demo ;;
esac

# --- docker (containerized workers; no host node needed) ---------------------
if [[ "$CMD" == "docker" ]]; then
  stop          # clear any prior workers / jails / container
  sleep 1
  docker_demo   # runs the container and execs wssnoop
fi

# --- start / attach from here ------------------------------------------------
[[ -n "$NODE" ]] || { echo "node not found — is nvm sourced?"; exit 1; }
npm install --no-audit --no-fund >/dev/null 2>&1 || true

# delay_ms: how long each worker waits before opening its connections. setsid
# fully detaches them so they outlive the launcher / wssnoop (stop with --stop).
start_workers() {
  local delay="${1:-0}"
  : > "$PIDFILE" # record exactly the pids we start, so stop() targets only them
  for r in "${ROLES[@]}"; do
    # Default: no recycle — --attach already gives clean handshakes, so steady
    # feeds make a calmer demo. Pass --recycle <ms> to exercise reconnect churn.
    # setsid execs the runtime in place, so $! is the worker's own pid.
    if [[ "$r" == "$PY_ROLE" ]]; then
      setsid python3 worker.py --role "$r" --feeds coinbase,kraken --delay "$delay" \
        --recycle "$RECYCLE" \
        >"/tmp/wssnoop-$r.log" 2>&1 </dev/null &
    else
      setsid node worker.mjs --role "$r" --feeds coinbase,kraken,poly --delay "$delay" \
        --recycle "$RECYCLE" ${NODEFLATE:+--no-deflate} ${ABRUPT:+--abrupt} \
        >"/tmp/wssnoop-$r.log" 2>&1 </dev/null &
    fi
    echo "$!" >> "$PIDFILE"
  done
}

stop          # clear any prior run first
sleep 1

if [[ "$CMD" == "attach" ]]; then
  # A `--bin <node>` attach only hooks processes that exist when it attaches, so
  # the workers must be running first — but we still want wssnoop to catch their
  # handshakes. So start the worker processes now with a connect-delay, then
  # attach; they exist (and get hooked) immediately but don't dial out until
  # wssnoop is live.
  start_workers 8000
  sleep 1
  echo ">> workers up (connecting in ~7s); launching wssnoop…"
  cd "$REPO_DIR"
  exec "$YEET" run src/main.jsx -- --bin "$NODE"
fi

# --start
start_workers 0
sleep 1
echo ">> ${#ROLES[@]} workers up: ${ROLES[*]} ($PY_ROLE on python3, the rest on node)"
echo ">> node workers hold coinbase + kraken + polymarket; $PY_ROLE (python) holds coinbase + kraken"
echo ">> logs: /tmp/wssnoop-<role>.log"
echo ">>"
echo ">> attach wssnoop to the node workers (static SSL — probe the exe):"
echo ">>     $YEET run src/main.jsx -- --bin $NODE"
echo ">> $PY_ROLE runs on python (dynamic libssl); attach it separately, e.g.:"
echo ">>     $YEET run src/main.jsx -- --pid \$(pgrep -x $PY_ROLE)"
