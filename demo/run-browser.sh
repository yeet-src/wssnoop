#!/usr/bin/env bash
# Single-command launcher for the wssnoop demo.
#
# Ensures the Lima VM is up, installs Node + deps inside it, then runs the Node
# server in the foreground over an `ssh -L` tunnel. The server binds inside the
# VM and the tunnel forwards it to the macOS host, so the page opens at
# http://localhost:PORT in the host browser. Ctrl-C stops the server + tunnel.
#
# Why ssh -L rather than Lima's port auto-forward: the auto-forward proved
# flaky for this bind, and a foreground tunnel makes "one command, one lifetime"
# trivial — the command IS the running server.

set -euo pipefail

PORT="${PORT:-8080}"
YEET_DIR="${YEET_DIR:-/Users/ben/src/yeet/yeet}"
DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run_server='. "$HOME/.nvm/nvm.sh" 2>/dev/null || true; cd "'"$DEMO_DIR"'" && npm install --no-audit --no-fund >/dev/null 2>&1 && PORT='"$PORT"' exec node server.js'

# On Linux just run directly; on macOS go through the VM (per project CLAUDE.md).
if [[ "$(uname -s)" != "Darwin" ]]; then
  cd "$DEMO_DIR"; npm install --no-audit --no-fund; exec env PORT="$PORT" node server.js
fi

# --- macOS: drive the Lima VM -----------------------------------------------

VM="$(limactl list 2>/dev/null | awk '/^yeet\./ && ($2=="Running"||$2=="Started"){print $1; exit}')"
if [[ -z "${VM:-}" ]]; then
  echo ">> No yeet.* VM running; bringing up default via 'make vm'…"
  make -C "$YEET_DIR" vm
  VM="$(limactl list 2>/dev/null | awk '/^yeet\./ && ($2=="Running"||$2=="Started"){print $1; exit}')"
fi
echo ">> Using VM: $VM"

SSHCFG="$HOME/.lima/$VM/ssh.config"
SSH_HOST="$(awk '/^Host /{print $2; exit}' "$SSHCFG")"
in_vm() { ssh -F "$SSHCFG" "$SSH_HOST" "$@"; }

# Install Node if the VM doesn't have it. nvm keeps it user-local and avoids
# apt's stale Node; the resulting node still statically links OpenSSL — exactly
# the SSL_read/SSL_write path the snoop hooks.
if ! in_vm 'bash -lc "command -v node >/dev/null 2>&1"'; then
  echo ">> Installing Node in VM (one-time)…"
  in_vm 'bash -lc '\''set -e
    export NVM_DIR="$HOME/.nvm"; mkdir -p "$NVM_DIR"
    [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    . "$NVM_DIR/nvm.sh"; nvm install --lts'\'''
fi

in_vm 'bash -lc "pkill -f \"node server.js\" 2>/dev/null; true"' || true

# Free the host port: a leftover ssh -L tunnel from a prior run would both
# block our forward and serve a dead connection.
lsof -nP -tiTCP:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true

echo ">> Starting server in VM, forwarding to host :$PORT"
echo ">> Open http://localhost:$PORT  (Ctrl-C here stops the server)"
exec ssh -F "$SSHCFG" -L "$PORT:localhost:$PORT" "$SSH_HOST" "bash -lc '$run_server'"
