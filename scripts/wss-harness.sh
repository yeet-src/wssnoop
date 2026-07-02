#!/usr/bin/env bash
# wss-harness — drive a yeet TUI script headlessly for debugging, WITHOUT
# polluting the interactive shell's history.
#
# Why this exists: `tmux send-keys "<command>" Enter` types into the pane's
# *interactive* shell (fish here), which persists every command to history.
# Instead we run the command AS the pane's process via non-interactive bash
# (`bash --noprofile --norc -c …`), on a DEDICATED tmux server (`-L wssdbg`,
# `-f /dev/null`) that ignores the user's tmux config and never touches their
# session. send-keys is then used only for *keystrokes* into the TUI (q, mouse),
# which are not shell history.
#
# Usage:
#   scripts/wss-harness.sh launch '<shell command>'   # run cmd in a fresh pane
#   scripts/wss-harness.sh key <keys...>              # send keystrokes (e.g. q)
#   scripts/wss-harness.sh mouse <btn> <x> <y>        # SGR mouse: btn 0=L, 64=wheelUp, 65=wheelDn
#   scripts/wss-harness.sh cap                        # capture pane (plain text)
#   scripts/wss-harness.sh cape                       # capture pane (with escapes)
#   scripts/wss-harness.sh kill                       # tear the pane/server down
#
# The launched command should end with `; echo RC_$?` if you want to observe its
# exit code in the captured pane (proves it actually returned vs hung).
set -uo pipefail

# Fully detached from the ambient environment, so a run is reproducible no
# matter what tmux/shell config or working directory the caller happens to have:
#   -L wssdbg   a dedicated server, not the user's
#   -f /dev/null  ignore ~/.tmux.conf and any TMUX_* config
#   -c START_DIR  pin the pane's cwd (below) — a detached server otherwise
#                 inherits a nondeterministic cwd, and a launched command that
#                 shells out to git/relative paths then fails intermittently
#   bash --noprofile --norc (in `launch`)  ignore ~/.bashrc / ~/.profile
TM=(tmux -L wssdbg -f /dev/null)   # isolated server, no config
SES=wss
COLS="${WSS_COLS:-200}"
ROWS="${WSS_ROWS:-50}"

# Pin the pane's working directory to the repo root (this script lives in
# scripts/), overridable with WSS_CWD. Deterministic regardless of where the
# tmux server was first spawned.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
START_DIR="${WSS_CWD:-$(cd "$HERE/.." && pwd)}"

case "${1:-}" in
  launch)
    cmd="${2:?launch needs a command}"
    "${TM[@]}" kill-session -t "$SES" 2>/dev/null || true
    "${TM[@]}" new-session -d -s "$SES" -x "$COLS" -y "$ROWS" -c "$START_DIR" \
      "bash --noprofile --norc -c $(printf '%q' "$cmd")"
    # keep the pane after the command exits, so a clean exit's output (e.g. an
    # `RC_$?` marker) survives to be captured instead of closing the server.
    "${TM[@]}" set-option -t "$SES" remain-on-exit on
    ;;
  key)    shift; "${TM[@]}" send-keys -t "$SES" -l "$*" ;;
  mouse)
    btn="${2:?}"; x="${3:?}"; y="${4:?}"
    "${TM[@]}" send-keys -t "$SES" -l "$(printf '\033[<%s;%s;%sM' "$btn" "$x" "$y")"
    "${TM[@]}" send-keys -t "$SES" -l "$(printf '\033[<%s;%s;%sm' "$btn" "$x" "$y")"
    ;;
  cap)    "${TM[@]}" capture-pane -t "$SES" -p ;;
  cape)   "${TM[@]}" capture-pane -t "$SES" -e -p ;;
  kill)   "${TM[@]}" kill-session -t "$SES" 2>/dev/null || true ;;
  *) echo "usage: $0 {launch <cmd>|key <keys>|mouse <btn> <x> <y>|cap|cape|kill}" >&2; exit 2 ;;
esac
