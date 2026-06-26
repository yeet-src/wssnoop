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
  stop             stop all demo workers (and the demo container)
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
    start|attach|docker|stop|status) set_cmd "$1" ;;
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

# Reap stale wssnoop isolates. `yeet run` outlives its client: closing the
# terminal (or killing it) leaves the daemon-side isolate running its BPF tap,
# and those zombies starve a fresh attach until it hangs at "starting…". `yeet
# ps`/`yeet kill` clears any left from a prior run, so each attach starts clean.
reap_jails() {
  "$YEET" ps 2>/dev/null \
    | awk 'NR>1 && $1 ~ /^[0-9]+$/ && /main\.jsx/ { print $1 }' \
    | while read -r id; do "$YEET" kill "$id" >/dev/null 2>&1 || true; done
}

stop() {
  for r in "${ROLES[@]}"; do pkill -x "$r" 2>/dev/null || true; done
  pkill -f "worker.mjs" 2>/dev/null || true
  reap_jails
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
    echo ">> attach wssnoop (sees all workers — no --pid needed):"
    echo ">>     $YEET run src/main.jsx -- --bin ${NODE:-node}"
  else
    echo ">> no workers running — start them with ./demo/run.sh start"
  fi
}

case "$CMD" in
  ""|help) usage; exit 0 ;;
  status)  status; exit 0 ;;
  stop)    stop; echo "stopped demo workers"; exit 0 ;;
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
  for r in "${ROLES[@]}"; do
    # Default: no recycle — --attach already gives clean handshakes, so steady
    # feeds make a calmer demo. Pass --recycle <ms> to exercise reconnect churn.
    setsid node worker.mjs --role "$r" --feeds coinbase,kraken,poly --delay "$delay" \
      --recycle "$RECYCLE" ${NODEFLATE:+--no-deflate} ${ABRUPT:+--abrupt} \
      >"/tmp/wssnoop-$r.log" 2>&1 </dev/null &
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
echo ">> ${#ROLES[@]} workers up: ${ROLES[*]}"
echo ">> each holds coinbase + kraken + polymarket connections, churning subscriptions"
echo ">> logs: /tmp/wssnoop-<role>.log"
echo ">>"
echo ">> attach wssnoop (sees all workers — no --pid needed):"
echo ">>     $YEET run src/main.jsx -- --bin $NODE"
