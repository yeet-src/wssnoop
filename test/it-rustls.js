/* Integration test — rustls plaintext capture. Attaches rustprobe.bpf.o to a
 * running rustls binary (tokio-tungstenite) and asserts we capture egress
 * plaintext. yeet:bpf only, no decode.js / yeet:compression.
 *
 *   yeet run test/it-rustls.js -- --pid <pid> --bin /tmp/rust-worker --sym <mangled>
 *
 * The egress symbol is a mangled Rust name whose codegen hash changes per build,
 * so the runner resolves it with nm and passes it via --sym. Validates: the
 * rustls PlaintextSink::write boundary is hookable and the arm64 arg reads
 * (X1=ptr, X2=len) are right. */
import { BpfObject, RingBuf } from "yeet:bpf";

const pid = Number(yeet.args.pid);
const bin = yeet.args.bin || "/tmp/rust-worker";
const sym = yeet.args.sym;
const NEED = 2;
const TIMEOUT_MS = 25000;

if (!sym) {
  console.log("INTEGRATION_FAIL rustls: no --sym (resolve with nm)");
  yeet.exit(1);
}

const ctl = await new BpfObject({ exe: "../bin/rustprobe.bpf.o", base: import.meta.dirname })
  .bind("events", { kind: "ringbuf", btf_struct: "ssl_event" })
  .bind("focus", { kind: "array" })
  .attach("probe_rust_tls_write", { kind: "uprobe", binary: bin, pid, symbol: sym })
  .start();

console.log(`attached rustls PlaintextSink::write on ${bin} pid ${pid}`);

let writes = 0;
let sig = false; // saw a WS-frame opcode (0x81) or the upgrade GET
const done = () => {
  const ok = writes >= NEED && sig;
  console.log(`${ok ? "INTEGRATION_PASS" : "INTEGRATION_FAIL"} rustls writes=${writes} sig=${sig}`);
  yeet.exit(ok ? 0 : 1);
};

const rb = new RingBuf(ctl, "events");
await rb.subscribe((w) => {
  const e = w?.ssl_event ?? w;
  if (!e) return;
  writes += 1;
  const b0 = e.data[0];
  const s = String.fromCharCode(...e.data.slice(0, Math.min(16, e.cap_len)));
  if (b0 === 0x81 || s.startsWith("GET /")) sig = true;
  if (writes >= NEED && sig) done();
});

setTimeout(done, TIMEOUT_MS);
await new Promise(() => {});
