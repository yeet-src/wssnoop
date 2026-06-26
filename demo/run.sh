#!/usr/bin/env bash
# wssnoop demo — one command, no browser.
#
# Launches several worker processes (distinct identities), each holding multiple
# live wss:// connections (coinbase + kraken + polymarket) and continuously
# churning subscriptions, so wssnoop has rich multi-process, multi-connection,
# bidirectional traffic to show immediately.
#
#   ./demo/run.sh             start the traffic, print the wssnoop attach command
#   ./demo/run.sh --attach    start the traffic AND launch wssnoop attached to it
#   ./demo/run.sh --stop      stop all demo workers
#
# Traffic-shaping knobs (pass as FLAGS, not env vars — the VM's login shell is
# fish, which silently ignores `VAR=val ./run.sh`, so flags are the safe path):
#   --recycle MS   recycle each connection every ~MS (jittered ×1–2); 0 = never
#   --no-deflate   disable permessage-deflate on the workers
#   --abrupt       recycle by terminate() (no CLOSE/shutdown) — exercises resets
# (Env vars RECYCLE / NODEFLATE / ABRUPT still work as fallback defaults.)
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

# Knobs default from the environment (back-compat) and are overridden by flags.
ATTACH=""
STOP=""
RECYCLE="${RECYCLE:-0}"
NODEFLATE="${NODEFLATE:-}"
ABRUPT="${ABRUPT:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --attach)     ATTACH=1 ;;
    --stop)       STOP=1 ;;
    --recycle)    RECYCLE="$2"; shift ;;
    --recycle=*)  RECYCLE="${1#*=}" ;;
    --no-deflate) NODEFLATE=1 ;;
    --abrupt)     ABRUPT=1 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

stop() {
  for r in "${ROLES[@]}"; do pkill -x "$r" 2>/dev/null || true; done
  pkill -f "worker.mjs" 2>/dev/null || true
}

if [[ "$STOP" == 1 ]]; then stop; echo "stopped demo workers"; exit 0; fi

command -v node >/dev/null || { echo "node not found — is nvm sourced?"; exit 1; }
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

NODE="$(command -v node)"
YEET="$(command -v yeet 2>/dev/null || echo /opt/yeet/crates/target/release/yeet)"

stop
sleep 1

if [[ "$ATTACH" == 1 ]]; then
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

start_workers 0
sleep 1
echo ">> ${#ROLES[@]} workers up: ${ROLES[*]}"
echo ">> each holds coinbase + kraken + polymarket connections, churning subscriptions"
echo ">> logs: /tmp/wssnoop-<role>.log"
echo ">>"
echo ">> attach wssnoop (sees all workers — no --pid needed):"
echo ">>     $YEET run src/main.jsx -- --bin $NODE"
