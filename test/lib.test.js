/* wssnoop unit tests — pure decode / aggregation / formatting logic.
 *
 * Runs in the yeet V8 isolate (so yeet:compression and friends resolve):
 *   yeet run test/lib.test.js
 * Exits nonzero on any failure. No framework — a tiny assert harness; the
 * modules under test are pure, so this needs no BPF, daemon, or UI.
 */

import { createTimeHist, UP, DOWN } from "../src/lib/timehist.js";
import { createDecoder, parseFrame, DIR_READ, DIR_WRITE } from "../src/lib/decode.js";
import { createRegistry } from "../src/state.js";
import { base64, messageRecord, toJsonl } from "../src/lib/export.js";
import { rankMap, recentBytes, connMetric } from "../src/lib/rank.js";
import { fmtBytes, fmtAgo, jsonTokens, hexDump } from "../src/lib/format.js";

let pass = 0;
let fail = 0;
const J = (x) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
const eq = (a, b, msg) => {
  if (J(a) === J(b)) pass++;
  else (fail++, console.log(`FAIL ${msg}\n  got ${J(a)}\n  want ${J(b)}`));
};
const ok = (c, msg) => (c ? pass++ : (fail++, console.log(`FAIL ${msg}`)));

/* ---- a WS frame on the wire ----------------------------------------- */
function frame({ opcode = 0x1, payload = new Uint8Array(0), masked = false, fin = true, rsv1 = false }) {
  const len = payload.length;
  const b0 = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode;
  let lenh;
  if (len < 126) lenh = [(masked ? 0x80 : 0) | len];
  else if (len < 65536) lenh = [(masked ? 0x80 : 0) | 126, (len >> 8) & 0xff, len & 0xff];
  else lenh = [(masked ? 0x80 : 0) | 127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
  const mask = masked ? [1, 2, 3, 4] : [];
  const body = masked ? payload.map((b, i) => b ^ mask[i & 3]) : payload;
  return new Uint8Array([b0, ...lenh, ...mask, ...body]);
}
const bytes = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const evt = (data, extra = {}) => ({ pid: 1, tid: 1, ssl: 7n, dir: DIR_READ, ts: 0, data, cap_len: data.length, len: data.length, ...extra });

/* ==== timehist ======================================================= */
{
  const h = createTimeHist({ bucketMs: 1000, buckets: 60 });
  const now = 60_000;
  h.add(now, UP, 100);
  h.add(now, UP, 50);
  h.add(now, DOWN, 30);
  eq(h.totalUp, 150, "timehist totalUp accumulates");
  eq(h.totalDown, 30, "timehist totalDown accumulates");
  eq(h.lastActive, now, "timehist lastActive");
  const w = h.window(now, 5000, 5);
  eq(w.up.reduce((a, b) => a + b, 0), 150, "window sums up in span");
  eq(w.down.reduce((a, b) => a + b, 0), 30, "window sums down in span");
  ok(w.peak >= 150, "window peak >= max");
  // outside the span -> not counted
  const old = createTimeHist({ bucketMs: 1000, buckets: 60 });
  old.add(1000, UP, 999);
  eq(old.window(60_000, 5000, 5).up.reduce((a, b) => a + b, 0), 0, "stale bucket excluded from window");
}

/* ==== decode: framing ================================================ */
{
  const d = createDecoder();
  // a single unmasked TEXT json frame (>=8 bytes so kind=frames is detected)
  const text = '{"hello":"world","n":42}';
  const out = d.push(evt(frame({ opcode: 0x1, payload: bytes(text) })));
  const msgs = out.filter((e) => e.type === "message");
  eq(msgs.length, 1, "one message from one frame");
  eq(msgs[0].msg.text, text, "TEXT payload decoded");
  eq(JSON.parse(msgs[0].msg.text), { hello: "world", n: 42 }, "TEXT round-trips as JSON");
  eq(msgs[0].msg.opcode, 0x1, "opcode TEXT");
  eq(msgs[0].msg.frames, 1, "single frame count");
}
{
  // masked client frame unmasks correctly
  const d = createDecoder();
  const text = "masked-egress-payload";
  const out = d.push(evt(frame({ opcode: 0x1, payload: bytes(text), masked: true }), { dir: DIR_WRITE }));
  const m = out.find((e) => e.type === "message");
  eq(m.msg.text, text, "masked frame unmasked");
  eq(m.msg.masked, true, "masked flag set");
}
{
  // fragmented message: TEXT(fin=0) + CONT(fin=1)
  const d = createDecoder();
  const a = "aaaaaaaa";
  const b = "bbbbbbbb";
  d.push(evt(frame({ opcode: 0x1, payload: bytes(a), fin: false })));
  const out = d.push(evt(frame({ opcode: 0x0, payload: bytes(b), fin: true })));
  const m = out.find((e) => e.type === "message");
  eq(m.msg.text, a + b, "fragments reassembled");
  eq(m.msg.frames, 2, "frame count = 2");
}
{
  // CLOSE control frame carries code + reason
  const d = createDecoder();
  const payload = new Uint8Array([0x03, 0xe8, ...bytes("bye-now!")]); // 1000 "bye-now!"
  const out = d.push(evt(frame({ opcode: 0x8, payload })));
  const m = out.find((e) => e.type === "message");
  eq(m.msg.closeCode, 1000, "close code parsed");
  eq(m.msg.closeReason, "bye-now!", "close reason parsed");
  eq(m.msg.control, true, "close is control");
}
{
  // 126 extended length path
  const d = createDecoder();
  const big = "x".repeat(300);
  const out = d.push(evt(frame({ opcode: 0x1, payload: bytes(big) })));
  const m = out.find((e) => e.type === "message");
  eq(m.msg.len, 300, "extended (126) length parsed");
}

/* ==== decode: parseFrame needs-more ================================== */
{
  ok(parseFrame(new Uint8Array([0x81])) === null, "parseFrame returns null for partial header");
  const full = frame({ opcode: 0x1, payload: bytes("abcdef") });
  const f = parseFrame(full);
  ok(f && f.consumed === full.length, "parseFrame consumes whole frame");
}

/* ==== decode: robustness paths ====================================== */
{
  // truncated chunk (cap_len < len) abandons the stream permanently
  const d = createDecoder();
  d.push(evt(frame({ opcode: 0x1, payload: bytes("hello-world") })));
  const out = d.push({ ...evt(new Uint8Array(10)), cap_len: 10, len: 100 });
  ok(out.some((e) => e.type === "truncated"), "truncated emitted when cap_len < len");
  const after = d.push(evt(frame({ opcode: 0x1, payload: bytes("more-data-here") })));
  eq(after.filter((e) => e.type === "message").length, 0, "no messages after truncation (stream done)");
}
{
  // absurd 127-length is flagged corrupt, not buffered
  const hugeLen = new Uint8Array([0x81, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const f = parseFrame(hugeLen);
  ok(f && f.corrupt, "parseFrame flags an absurd length as corrupt");
}
{
  // an HTTP handshake arriving mid-frames (SSL* reuse) resets the stream
  const d = createDecoder();
  d.push(evt(frame({ opcode: 0x1, payload: bytes("first-message-data") })));
  const http = bytes("GET /ws HTTP/1.1\r\nHost: x.com\r\nUpgrade: websocket\r\n\r\n");
  const out = d.push(evt(http));
  ok(out.some((e) => e.type === "reset"), "HTTP mid-stream emits a reset");
}

/* ==== export ========================================================= */
{
  eq(base64(bytes("Man")), "TWFu", "base64 3-byte group");
  eq(base64(bytes("Ma")), "TWE=", "base64 2-byte pad");
  eq(base64(bytes("M")), "TQ==", "base64 1-byte pad");
  eq(base64(new Uint8Array(0)), "", "base64 empty");

  const recOut = { seq: 5, at: 0, dir: DIR_WRITE, name: "TEXT", len: 3, wireLen: 3, compressed: false, text: "hey", bytes: null };
  const r = messageRecord(recOut);
  eq(r.dir, "out", "export dir out for DIR_WRITE");
  eq(r.text, "hey", "export keeps non-JSON text");
  ok(!("base64" in r), "export omits base64 when text present");

  // text that parses as JSON exports as structured json
  const recJson = messageRecord({ seq: 7, dir: DIR_READ, name: "TEXT", len: 9, text: '{"a":1,"b":[2]}' });
  eq(recJson.json, { a: 1, b: [2] }, "export parses JSON text to json on demand");
  ok(!("text" in recJson), "export omits raw text when it's JSON");

  const recBin = { seq: 6, dir: DIR_READ, name: "BIN", len: 2, text: null, json: undefined, bytes: new Uint8Array([1, 2]) };
  eq(messageRecord(recBin).base64, base64(new Uint8Array([1, 2])), "export base64 for binary");

  // toJsonl is oldest-first (input is newest-first)
  const newestFirst = [{ seq: 2, dir: DIR_READ, name: "TEXT", len: 1, text: "b" }, { seq: 1, dir: DIR_READ, name: "TEXT", len: 1, text: "a" }];
  const lines = toJsonl(newestFirst).split("\n").map((l) => JSON.parse(l).seq);
  eq(lines, [1, 2], "toJsonl is chronological (oldest first)");
}

/* ==== rank =========================================================== */
{
  const h1 = createTimeHist();
  const h2 = createTimeHist();
  h1.add(1000, UP, 10);
  h2.add(1000, UP, 1000);
  const items = [{ key: "a", hist: h1, startedAt: 1 }, { key: "b", hist: h2, startedAt: 2 }];
  const m = rankMap(items, (c) => c.key, (c) => connMetric(c, "bytes", 2000, 5000));
  eq(m.get("b"), 0, "bigger bytes ranks first (0)");
  eq(m.get("a"), 1, "smaller bytes ranks second");
  ok(recentBytes(h2, 2000, 5000) >= 1000, "recentBytes sees recent traffic");
}

/* ==== format ========================================================= */
{
  eq(fmtBytes(0), "0B", "fmtBytes 0");
  eq(fmtBytes(512), "512B", "fmtBytes bytes");
  eq(fmtBytes(1024), "1.0K", "fmtBytes K");
  eq(fmtBytes(1024 * 1024), "1.0M", "fmtBytes M");
  eq(fmtAgo(0), "now", "fmtAgo now");
  eq(fmtAgo(3000), "3s", "fmtAgo seconds");
  eq(fmtAgo(120000), "2m", "fmtAgo minutes");

  const toks = jsonTokens('  "key": "val",');
  eq(toks.find((t) => t.text === '"key"').kind, "key", "jsonTokens detects key");
  eq(toks.find((t) => t.text === '"val"').kind, "str", "jsonTokens detects string value");
  const nums = jsonTokens('  "n": 42,');
  eq(nums.find((t) => t.text === "42").kind, "num", "jsonTokens detects number");
  const lit = jsonTokens("  true");
  eq(lit.find((t) => t.text === "true").kind, "lit", "jsonTokens detects literal");

  const dump = hexDump(new Uint8Array([0x41, 0x42, 0x43]));
  ok(dump.includes("41 42 43"), "hexDump shows hex");
  ok(dump.includes("ABC"), "hexDump shows ascii");
}

/* ==== state registry ================================================= */
{
  const reg = createRegistry();
  const t = 1000;
  reg.ingest(
    {
      type: "handshake", pid: 1, ssl: 10n, dir: DIR_WRITE,
      startLine: "GET /ws?x=1 HTTP/1.1",
      headers: { host: "ex.com", "sec-websocket-protocol": "json", origin: "https://ex.com" },
      deflate: { windowBits: 15, noContextTakeover: true },
    },
    t,
  );
  reg.ingest({ type: "message", pid: 1, ssl: 10n, dir: DIR_WRITE, msg: { name: "TEXT", opcode: 1, len: 10, wireLen: 6, compressed: true } }, t + 1);
  reg.ingest({ type: "message", pid: 1, ssl: 10n, dir: DIR_READ, msg: { name: "TEXT", opcode: 1, len: 20, wireLen: 8, compressed: true, text: "hi", json: { a: 1 } } }, t + 2);
  const c = reg.snapshot().groups[0].conns[0];
  eq(c.role, "client", "registry: role=client from egress handshake");
  eq(c.dest, "wss://ex.com/ws?x=1", "registry: dest from host + path");
  eq(c.subprotocol, "json", "registry: subprotocol header retained");
  eq(c.origin, "https://ex.com", "registry: origin header retained");
  eq(c.deflate.windowBits, 15, "registry: deflate params retained");
  eq([c.msgUp, c.msgDn], [1, 1], "registry: up/down message counts");
  eq(c.opcodes.TEXT, 2, "registry: opcode histogram");
  eq([c.wireBytes, c.inflatedBytes], [14, 30], "registry: wire vs inflated byte sums");
  eq(c.msgs.size, 2, "registry: messages retained in ring");
}
{
  // an ingress handshake (the upgrade request arrives) => we are the server
  const reg = createRegistry();
  reg.ingest({ type: "handshake", pid: 4, ssl: 40n, dir: DIR_READ, startLine: "GET /socket HTTP/1.1", headers: { host: "us.local" } }, 1);
  const c = reg.snapshot().groups[0].conns[0];
  eq(c.role, "server", "registry: role=server from ingress handshake");
  eq(c.dest, "?", "registry: server dest unknown");
}
{
  // a non-websocket on the SSL* forgets the connection
  const reg = createRegistry();
  reg.ingest({ type: "message", pid: 2, ssl: 20n, dir: DIR_READ, msg: { name: "TEXT", opcode: 1, len: 5 } }, 1);
  eq(reg.snapshot().groups.length, 1, "registry: conn created from a frame");
  reg.ingest({ type: "non-websocket", pid: 2, ssl: 20n, dir: DIR_READ }, 2);
  eq(reg.snapshot().groups.length, 0, "registry: non-websocket drops the conn");
}
{
  // CLOSE → closed + focusGone; data kept, evicted only by the idle retention
  const reg = createRegistry();
  reg.ingest({ type: "message", pid: 3, ssl: 30n, dir: DIR_READ, msg: { name: "TEXT", opcode: 1, len: 5 } }, 1000);
  reg.ingest({ type: "message", pid: 3, ssl: 30n, dir: DIR_READ, msg: { name: "CLOSE", opcode: 0x8, control: true, len: 2, closeCode: 1000, closeReason: "bye" } }, 2000);
  const c = reg.snapshot().groups[0].conns[0];
  eq(c.status, "closed", "registry: CLOSE marks the conn closed");
  eq(c.closeCode, 1000, "registry: close code recorded");
  ok(reg.focusGone("3:30"), "registry: focusGone true for a closed conn");
  reg.evict(2000 + 21000); // well past the old 20s grace
  eq(reg.snapshot().groups.length, 1, "registry: a closed conn is kept (data stays inspectable)");
  reg.evict(2000 + 1_800_001); // past the idle retention window
  eq(reg.snapshot().groups.length, 0, "registry: closed conn evicted once it idles past retention");
}
{
  // SSL* reuse (reset): archive the old conn (keep its data) beside the fresh
  // one that takes over the live pid:ssl slot.
  const reg = createRegistry();
  reg.ingest({ type: "message", pid: 5, ssl: 50n, dir: DIR_READ, msg: { name: "TEXT", opcode: 1, len: 5 } }, 1000);
  reg.ingest({ type: "reset", pid: 5, ssl: 50n, dir: DIR_READ }, 1100);
  reg.ingest({ type: "message", pid: 5, ssl: 50n, dir: DIR_READ, msg: { name: "TEXT", opcode: 1, len: 9 } }, 1200);
  const conns = reg.snapshot().groups[0].conns;
  eq(conns.length, 2, "registry: recycle keeps the old conn beside the new one");
  const archived = conns.find((c) => c.status === "closed");
  const live = conns.find((c) => c.status === "open");
  ok(archived && archived.key.includes("#"), "registry: archived conn re-keyed out of the live slot");
  ok(archived && archived.msgs.total === 1, "registry: archived conn kept its scrollback");
  eq(live?.key, "5:50", "registry: the new conn holds the live pid:ssl key");

  // a reset before any WebSocket data has nothing to keep → just dropped
  const reg2 = createRegistry();
  reg2.ingest({ type: "truncated", pid: 7, ssl: 70n, dir: DIR_READ, capLen: 4096, len: 9000 }, 1);
  reg2.ingest({ type: "reset", pid: 7, ssl: 70n, dir: DIR_READ }, 2);
  eq(reg2.snapshot().groups.length, 0, "registry: recycle drops a conn that never carried WS data");
}
{
  // the inspected conn is pinned: it survives eviction while you're looking at it
  const reg = createRegistry();
  reg.ingest({ type: "message", pid: 8, ssl: 80n, dir: DIR_READ, msg: { name: "TEXT", opcode: 1, len: 5 } }, 1000);
  const conn = reg.snapshot().groups[0].conns[0];
  reg.evict(1000 + 200_000, conn); // well past retention, but pinned
  eq(reg.snapshot().groups.length, 1, "registry: a pinned (inspected) conn survives past retention");
  reg.evict(1000 + 200_000, null); // no longer inspected
  eq(reg.snapshot().groups.length, 0, "registry: once unpinned it evicts");
}
{
  // truncated is a capture artifact, orthogonal to status: the conn stays "open"
  // but is flagged, and focus releases (the decoder can't follow it anymore)
  const reg = createRegistry();
  reg.ingest({ type: "message", pid: 5, ssl: 50n, dir: DIR_READ, msg: { name: "TEXT", opcode: 1, len: 5 } }, 1000);
  reg.ingest({ type: "truncated", pid: 5, ssl: 50n, dir: DIR_READ, capLen: 4096, len: 9000 }, 1100);
  const c = reg.snapshot().groups[0].conns[0];
  eq(c.status, "open", "registry: truncation does not clobber status");
  ok(c.truncated, "registry: truncation sets the orthogonal flag");
  ok(reg.focusGone("5:50"), "registry: focusGone true for a truncated conn");
}

/* ---- summary -------------------------------------------------------- */
console.log(`\n${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
yeet.exit(fail === 0 ? 0 : 1);
