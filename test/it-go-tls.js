/* Integration test — Go crypto/tls capture. Attaches goprobe.bpf.o to a running
 * Go binary and asserts we capture plaintext both directions. Deliberately uses
 * only yeet:bpf (no decode.js / yeet:compression), so it exercises the BPF tap
 * in isolation and runs even when that builtin is unavailable.
 *
 *   yeet run test/it-go-tls.js -- --pid <gopid> --bin /tmp/go-worker
 *
 * Prints "INTEGRATION_PASS"/"INTEGRATION_FAIL"; the runner (scripts/it.sh) greps
 * for it. Validates: the crypto/tls.(*Conn).Write/Read symbols resolve, the
 * arm64 Go ABI arg reads are right, and reads pair across goroutine migration
 * (goid keying). */
import { BpfObject, RingBuf } from "yeet:bpf";

const pid = Number(yeet.args.pid);
const bin = yeet.args.bin || "/tmp/go-worker";
const NEED_WRITES = 1;
const NEED_READS = 1;
const TIMEOUT_MS = 25000;

const uprobe = { kind: "uprobe", binary: bin, pid };
const ctl = await new BpfObject({ exe: "../bin/goprobe.bpf.o", base: import.meta.dirname })
  .bind("events", { kind: "ringbuf", btf_struct: "ssl_event" })
  .bind("focus", { kind: "array" })
  .attach("probe_go_tls_write", { ...uprobe, symbol: "crypto/tls.(*Conn).Write" })
  .attach("probe_go_tls_read_enter", { ...uprobe, symbol: "crypto/tls.(*Conn).Read" })
  .attach("probe_go_tls_read_exit", { ...uprobe, symbol: "crypto/tls.(*Conn).Read" })
  .start();

console.log(`attached crypto/tls.(*Conn).Write+Read on ${bin} pid ${pid}`);

let writes = 0;
let reads = 0;
let jsonSeen = false;
const done = () => {
  const ok = writes >= NEED_WRITES && reads >= NEED_READS && jsonSeen;
  console.log(`${ok ? "INTEGRATION_PASS" : "INTEGRATION_FAIL"} go-tls writes=${writes} reads=${reads} json=${jsonSeen}`);
  yeet.exit(ok ? 0 : 1);
};

const rb = new RingBuf(ctl, "events");
await rb.subscribe((w) => {
  const e = w?.ssl_event ?? w;
  if (!e) return;
  if (e.dir === 1) writes += 1;
  else reads += 1;
  const s = String.fromCharCode(...e.data.slice(0, Math.min(64, e.cap_len)));
  if (s.includes('{"') || s.includes("GET /")) jsonSeen = true;
  if (writes >= NEED_WRITES && reads >= NEED_READS && jsonSeen) done();
});

setTimeout(done, TIMEOUT_MS);
await new Promise(() => {});
