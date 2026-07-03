/* Integration test — rustls plaintext capture (tokio-tungstenite). Attaches
 * rustprobe.bpf.o to a running rustls binary and asserts we capture plaintext
 * both directions. yeet:bpf only, no decode.js / yeet:compression.
 *
 *   yeet run test/it-rustls.js -- --pid <pid> --bin /tmp/rust-worker \
 *       --wsym <PlaintextSink::write> --rsym <take_received_plaintext>
 *
 * Both are mangled Rust names whose codegen hash changes per build, so the
 * runner resolves them with nm and passes them. Validates: egress
 * (PlaintextSink::write, buf ptr=X1/len=X2 at entry) and ingress
 * (take_received_plaintext, the decrypted Vec behind X1) are both hookable and
 * fold into one connection id. */
import { BpfObject, RingBuf } from "yeet:bpf";

const pid = Number(yeet.args.pid);
const bin = yeet.args.bin || "/tmp/rust-worker";
const wsym = yeet.args.wsym;
const rsym = yeet.args.rsym;
const TIMEOUT_MS = 25000;

if (!wsym || !rsym) {
  console.log("INTEGRATION_FAIL rustls: need --wsym and --rsym (resolve with nm)");
  yeet.exit(1);
}

const up = { kind: "uprobe", binary: bin, pid };
const ctl = await new BpfObject({ exe: "../bin/rustprobe.bpf.o", base: import.meta.dirname })
  .bind("events", { kind: "ringbuf", btf_struct: "ssl_event" })
  .bind("focus", { kind: "array" })
  .attach("probe_rust_tls_write", { ...up, symbol: wsym })
  .attach("probe_rust_tls_read", { ...up, symbol: rsym })
  .start();

console.log(`attached rustls write+read on ${bin} pid ${pid}`);

let writes = 0;
let reads = 0;
let json = false;
const done = () => {
  const ok = writes >= 1 && reads >= 1 && json;
  console.log(`${ok ? "INTEGRATION_PASS" : "INTEGRATION_FAIL"} rustls writes=${writes} reads=${reads} json=${json}`);
  yeet.exit(ok ? 0 : 1);
};

const rb = new RingBuf(ctl, "events");
await rb.subscribe((w) => {
  const e = w?.ssl_event ?? w;
  if (!e) return;
  if (e.dir === 1) writes += 1;
  else reads += 1;
  const s = String.fromCharCode(...e.data.slice(0, Math.min(64, e.cap_len)));
  if (s.includes('{"')) json = true;
  if (writes >= 1 && reads >= 1 && json) done();
});

setTimeout(done, TIMEOUT_MS);
await new Promise(() => {});
