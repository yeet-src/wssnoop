/* wssnoop unit tests — pure decode / aggregation / formatting logic.
 *
 * Runs in the yeet V8 isolate (so yeet:compression and friends resolve):
 *   yeet run test/lib.test.js
 * Exits nonzero on any failure. No framework — a tiny assert harness; the
 * modules under test are pure, so this needs no BPF, daemon, or UI.
 */

import { createTimeHist, UP, DOWN } from "../src/lib/timehist.js";
import { createDecoder, parseFrame, DIR_READ, DIR_WRITE } from "../src/lib/decode.js";
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
  eq(msgs[0].msg.json, { hello: "world", n: 42 }, "JSON parsed");
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

/* ==== export ========================================================= */
{
  eq(base64(bytes("Man")), "TWFu", "base64 3-byte group");
  eq(base64(bytes("Ma")), "TWE=", "base64 2-byte pad");
  eq(base64(bytes("M")), "TQ==", "base64 1-byte pad");
  eq(base64(new Uint8Array(0)), "", "base64 empty");

  const recOut = { seq: 5, at: 0, dir: DIR_WRITE, name: "TEXT", len: 3, wireLen: 3, compressed: false, text: "hey", json: undefined, bytes: bytes("hey") };
  const r = messageRecord(recOut);
  eq(r.dir, "out", "export dir out for DIR_WRITE");
  eq(r.text, "hey", "export keeps text");
  ok(!("base64" in r), "export omits base64 when text present");

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

/* ---- summary -------------------------------------------------------- */
console.log(`\n${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
yeet.exit(fail === 0 ? 0 : 1);
