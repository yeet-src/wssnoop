/* Integration test — rustls plaintext capture (tokio-tungstenite). Attaches
 * rustprobe.bpf.o to a running rustls binary by `symbol_prefix` (the daemon
 * resolves the per-build codegen hash) and asserts we capture plaintext both
 * directions. yeet:bpf only, no decode.js / yeet:compression.
 *
 *   yeet run test/it-rustls.js -- --pid <pid> --bin /tmp/rust-worker
 *
 * Validates the full dynamic path: symbol_prefix resolves, egress
 * (PlaintextSink::write, buf ptr=X1/len=X2 at entry) and ingress
 * (take_received_plaintext, the decrypted bytes behind X1) are both hookable
 * and fold into one connection id. Prefixes match probe.js. */
import { BpfObject, RingBuf } from "yeet:bpf";

const pid = Number(yeet.args.pid);
const bin = yeet.args.bin || "/tmp/rust-worker";
const TIMEOUT_MS = 25000;

const WRITE_PREFIX =
  "_ZN99_$LT$rustls..conn..ConnectionCommon$LT$T$GT$$u20$as$u20$rustls..conn..connection..PlaintextSink$GT$5write17h";
const READ_PREFIX = "_ZN6rustls12common_state11CommonState23take_received_plaintext17h";

const up = { kind: "uprobe", binary: bin, pid };
const ctl = await new BpfObject({ exe: "../bin/rustprobe.bpf.o", base: import.meta.dirname })
  .bind("events", { kind: "ringbuf", btf_struct: "ssl_event" })
  .bind("focus", { kind: "array" })
  .attach("probe_rust_tls_write", { ...up, symbol_prefix: WRITE_PREFIX })
  .attach("probe_rust_tls_read", { ...up, symbol_prefix: READ_PREFIX })
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
