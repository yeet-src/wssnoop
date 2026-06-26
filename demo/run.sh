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
# Run it inside the yeet VM (where node + yeet live). Attaches by --bin <node>
# with no --pid, so wssnoop sees every worker — current and future.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEMO_DIR/.." && pwd)"
cd "$DEMO_DIR"
# shellcheck disable=SC1091
. "$HOME/.nvm/nvm.sh" 2>/dev/null || true

ROLES=(order-router md-gateway risk-engine)

stop() {
  for r in "${ROLES[@]}"; do pkill -x "$r" 2>/dev/null || true; done
  pkill -f "worker.mjs" 2>/dev/null || true
}

if [[ "${1:-}" == "--stop" ]]; then stop; echo "stopped demo workers"; exit 0; fi

command -v node >/dev/null || { echo "node not found — is nvm sourced?"; exit 1; }
npm install --no-audit --no-fund >/dev/null 2>&1 || true

# delay_ms: how long each worker waits before opening its connections. setsid
# fully detaches them so they outlive the launcher / wssnoop (stop with --stop).
start_workers() {
  local delay="${1:-0}"
  for r in "${ROLES[@]}"; do
    setsid node worker.mjs --role "$r" --feeds coinbase,kraken,poly --delay "$delay" \
      >"/tmp/wssnoop-$r.log" 2>&1 </dev/null &
  done
}

NODE="$(command -v node)"
YEET="$(command -v yeet 2>/dev/null || echo /opt/yeet/crates/target/release/yeet)"

stop
sleep 1

if [[ "${1:-}" == "--attach" ]]; then
  # A `--bin <node>` attach only hooks processes that exist when it attaches, so
  # the workers must be running first — but we still want wssnoop to catch their
  # handshakes. So start the worker processes now with a connect-delay, then
  # attach; they exist (and get hooked) immediately but don't dial out until
  # wssnoop is live.
  start_workers 5000
  sleep 1
  echo ">> workers up (connecting in ~4s); launching wssnoop…"
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
