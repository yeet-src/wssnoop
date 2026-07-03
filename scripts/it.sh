#!/usr/bin/env bash
# wssnoop integration tests — attach the language TLS taps to a real workload
# and assert we capture plaintext. Unlike test/lib.test.js (pure unit tests),
# these need a Linux kernel, root (BPF), the yeet runtime, and the language
# toolchains — so they run in the yeet VM / a privileged CI kernel, not the
# unit-test path.
#
#   scripts/it.sh [go|rust|all]
#
# Each case: build the BPF object + a worker for that runtime, start the worker
# against a live wss:// feed, run its it-*.js probe test, and grep the probe's
# INTEGRATION_PASS marker. Exits nonzero if any case fails. The taps run in
# their own BPF objects and import only yeet:bpf, so this does NOT depend on the
# yeet:compression builtin (decode is unit-tested separately).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
YEET="$(command -v yeet 2>/dev/null || echo /opt/yeet/crates/target/release/yeet)"
WHICH="${1:-all}"
rc=0

log() { printf '\n=== %s ===\n' "$*"; }

make bpf >/dev/null 2>&1 || { echo "make bpf failed"; exit 1; }

run_probe() { # <name> <test.js> <extra args...>
  local name="$1" test="$2"; shift 2
  local out
  out="$(timeout 40 "$YEET" run "$test" -- "$@" 2>&1)"
  echo "$out" | grep -E "attached|INTEGRATION_" || true
  if echo "$out" | grep -q "INTEGRATION_PASS"; then
    echo ">> $name: PASS"
  else
    echo ">> $name: FAIL"; rc=1
  fi
}

test_go() {
  log "go crypto/tls"
  command -v go >/dev/null || { echo "go not installed — skipping"; return; }
  pkill -x go-fanout 2>/dev/null; sleep 1 # free /tmp/go-worker (text-busy) before rebuild
  (cd demo/goworker && GOFLAGS=-mod=mod go build -o /tmp/go-worker . ) || { echo "go build failed"; rc=1; return; }
  ( cd /tmp && setsid /tmp/go-worker --role go-fanout --feeds coinbase --recycle 10000 >/tmp/it-go.log 2>&1 </dev/null & )
  sleep 5
  local pid; pid="$(pgrep -x go-fanout | head -1)"
  [ -n "$pid" ] || { echo "go-worker didn't start"; rc=1; return; }
  run_probe "go-tls" test/it-go-tls.js --pid "$pid" --bin /tmp/go-worker
  pkill -x go-fanout 2>/dev/null
}

test_rust() {
  log "rustls"
  command -v cargo >/dev/null || { echo "cargo not installed — skipping"; return; }
  ( cd demo/rustworker && cargo build --release ) >/tmp/it-rust-build.log 2>&1 || { echo "cargo build failed (see /tmp/it-rust-build.log)"; rc=1; return; }
  pkill -x rust-worker 2>/dev/null; sleep 1 # free /tmp/rust-worker (text-busy) before copy
  cp demo/rustworker/target/release/rust-worker /tmp/rust-worker
  ( cd /tmp && setsid /tmp/rust-worker --role rust-md --feeds coinbase --recycle 10000 >/tmp/it-rust.log 2>&1 </dev/null & )
  sleep 5
  local pid sym
  pid="$(pgrep -x rust-worker | head -1)"
  [ -n "$pid" ] || { echo "rust-worker didn't start"; rc=1; return; }
  # The rustls egress symbol carries a per-build codegen hash — resolve it now.
  # ..PlaintextSink$GT$5write17h<hash>E — the 5write disambiguates from write_vectored.
  sym="$(nm --defined-only /tmp/rust-worker 2>/dev/null | awk '{print $3}' | grep -E 'PlaintextSink.*5write17h' | grep -v vectored | head -1)"
  [ -n "$sym" ] || { echo "could not resolve rustls egress symbol"; rc=1; pkill -x rust-worker; return; }
  run_probe "rustls" test/it-rustls.js --pid "$pid" --bin /tmp/rust-worker --sym "$sym"
  pkill -x rust-worker 2>/dev/null
}

[ "$WHICH" = go ] || [ "$WHICH" = all ] && test_go
[ "$WHICH" = rust ] || [ "$WHICH" = all ] && test_rust

log "result"
[ "$rc" -eq 0 ] && echo "ALL INTEGRATION TESTS PASSED" || echo "INTEGRATION FAILURES"
exit "$rc"
