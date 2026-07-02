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
import { compile, messageText } from "../src/lib/query.js";
import { resolveBin, discoverTargets, DEFAULT_BIN, isExplicit } from "../src/probes/discover.js";

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

/* ==== query (message filter language) ================================ */
{
  const m = (q, text) => compile(q).test({ text });
  // plain text is an unsplit substring (original behaviour), case-insensitive
  ok(m("hello", "well hello there"), "query: plain substring matches");
  ok(m("HELLO", "say hello"), "query: plain substring is case-insensitive");
  ok(!m("xyz", "abc"), "query: plain substring miss");
  ok(m("", "anything"), "query: empty query matches everything");

  const trade = '{"type":"trade","price":150,"sym":"BTC-USD","tags":["a"]}';
  const quote = '{"type":"quote","price":50.5}';
  // numeric comparisons
  ok(m("$.price > 100", trade), "query: > matches");
  ok(!m("$.price > 100", quote), "query: > excludes");
  ok(m("$.price>=50.5", quote), "query: >= with glued op + float");
  ok(m("$.price < 100", quote), "query: < matches");
  ok(!m("$.price <= 49", quote), "query: <= excludes");
  // typed equality
  ok(m('$.type == "trade"', trade), "query: == string (quoted)");
  ok(m("$.type==trade", trade), "query: == string (bareword, glued)");
  ok(!m('$.type == "trade"', quote), "query: == excludes");
  ok(m("$.price != 1", trade), "query: != matches");
  ok(!m("$.price != 150", trade), "query: != excludes on equal");
  // substring on a field, and nested / indexed paths
  ok(m("$.sym ~ usd", trade), "query: ~ field substring, case-insensitive");
  ok(m("$.tags[0] == a", trade), "query: [n] index path");
  ok(!m("$.tags[1]", trade), "query: presence false for missing index");
  // presence
  ok(m("$.sym", trade), "query: presence matches a present field");
  ok(!m("$.error", trade), "query: presence false for absent field");
  // absent field never matches a comparison (not even !=)
  ok(!m("$.missing > 0", trade), "query: absent field fails numeric compare");
  ok(!m("$.missing != 5", trade), "query: absent field fails !=");
  // conjunction: every term must hold
  ok(m("$.price > 100 BTC", trade), "query: field AND text both hold");
  ok(!m("$.price > 100 ETH", trade), "query: AND fails when text term misses");
  ok(!m("$.price > 200 BTC", trade), "query: AND fails when field term misses");
  // explicit encoding prefix resolves the same as the default
  ok(m("$json.price > 100", trade), "query: explicit $json prefix");
  // non-JSON body: field terms simply don't match, text still does
  ok(!m("$.price > 0", "not json"), "query: field test on non-JSON misses");
  ok(m("json", "not json here"), "query: text term still works on non-JSON");
  // a literal $ that isn't an accessor degrades to text
  ok(m("$5", "it costs $5"), "query: bare $ token falls back to text");

  // messageText haystack = opcode + text + inflate error, tolerant of gaps
  eq(messageText({ name: "TEXT", text: '{"a":1}' }), 'TEXT {"a":1}', "messageText joins name + text");
  eq(messageText({ name: "BIN" }), "BIN ", "messageText tolerates missing text");
}

/* ==== msg ring count (per-service search-match counting) ============== */
{
  // the retained-message ring counts matches without materializing an array —
  // exercised via a real registry (createMsgRing is internal)
  const reg = createRegistry();
  const text = (s) => ({ type: "message", pid: 1, ssl: 9n, dir: DIR_READ, msg: { name: "TEXT", opcode: 1, len: s.length, text: s } });
  reg.ingest(text('{"type":"trade"}'), 1);
  reg.ingest(text('{"type":"quote"}'), 2);
  reg.ingest(text('{"type":"trade"}'), 3);
  const ring = reg.snapshot().groups[0].conns[0].msgs;
  const { test } = compile('$.type == "trade"', { text: messageText });
  eq(ring.count(test), 2, "ring.count tallies matching messages");
  eq(ring.count(() => true), ring.size, "ring.count(all) == size");
  eq(ring.count(() => false), 0, "ring.count(none) == 0");
}

/* ==== binary discovery (probes/discover.js, against a fake graph) ===== */
{
  /* A fake system graph: answers `proc(pid: N)` from `byPid`, any `procs` list
   * from `procs`. `query` is async, matching the real yeet.graph shape. */
  const graph = ({ procs = [], byPid = {} } = {}) => ({
    query: (q) => {
      const m = /proc\(pid:\s*(\d+)\)/.exec(q);
      if (m) return Promise.resolve({ data: { proc: byPid[m[1]] ?? null } });
      return Promise.resolve({ data: { procs } });
    },
  });
  const R = async (args, world, msg) => eq(await resolveBin(args, graph(world)), world.want, msg);

  // isExplicit: a path, a .so, or a libssl name skips discovery entirely.
  ok(isExplicit("/usr/bin/node") && isExplicit("libssl.so.3") && isExplicit("libssl"), "isExplicit path/.so/libssl");
  ok(!isExplicit("node") && !isExplicit("python3"), "isExplicit rejects bare names");
  eq(await resolveBin({ bin: "/opt/node" }, graph({})), "/opt/node", "explicit path returned as-is (no graph)");
  eq(await resolveBin({ bin: "libssl.so" }, graph({})), "libssl.so", "explicit library returned as-is");

  // --pid, static SSL (node): no libssl mapped → the exe, namespace-rewritten.
  await R({ pid: 42 }, { byPid: { 42: { exe: "/usr/bin/node", maps: [] } }, want: "/proc/42/root/usr/bin/node" }, "--pid static → namespaced exe");
  // --pid, dynamic SSL: a mapped libssl wins over the exe.
  await R(
    { pid: 7 },
    { byPid: { 7: { exe: "/usr/bin/python3", maps: [{ path: "/usr/lib/x86_64-linux-gnu/libssl.so.3" }] } }, want: "/proc/7/root/usr/lib/x86_64-linux-gnu/libssl.so.3" },
    "--pid dynamic → namespaced libssl",
  );
  // --pid inside a container: the in-container exe path becomes host-attachable
  // through /proc/<pid>/root — the whole point of container support.
  await R({ pid: 900 }, { byPid: { 900: { exe: "/usr/local/bin/node", maps: [] } }, want: "/proc/900/root/usr/local/bin/node" }, "--pid container → /proc/pid/root rewrite");
  // --pid gone (proc null) → fall back, never throw.
  await R({ pid: 404 }, { byPid: {}, want: DEFAULT_BIN }, "--pid gone → default");

  // bare --bin name matches by exe basename, then resolves that pid's SSL path.
  await R(
    { bin: "node" },
    { procs: [{ stat: { pid: 5, comm: "MainThread" }, exe: "/usr/bin/node" }], byPid: { 5: { exe: "/usr/bin/node", maps: [] } }, want: "/proc/5/root/usr/bin/node" },
    "--bin node matches by exe basename",
  );
  // matches by comm when the exe basename differs (a renamed/wrapped binary).
  await R(
    { bin: "ruby" },
    { procs: [{ stat: { pid: 8, comm: "ruby" }, exe: "/opt/rbenv/versions/3.3/bin/ruby3.3" }], byPid: { 8: { exe: "/opt/rbenv/versions/3.3/bin/ruby3.3", maps: [{ path: "/lib/libssl.so.3" }] } }, want: "/proc/8/root/lib/libssl.so.3" },
    "--bin ruby matches by comm",
  );
  await R({ bin: "nope" }, { procs: [{ stat: { pid: 5, comm: "node" }, exe: "/usr/bin/node" }], want: DEFAULT_BIN }, "--bin unmatched → default");

  // no args: pick the first running known runtime, in KNOWN_BINS order (node
  // before python), then its SSL path.
  await R(
    {},
    {
      procs: [
        { stat: { pid: 3, comm: "python3" }, exe: "/usr/bin/python3" },
        { stat: { pid: 4, comm: "node" }, exe: "/usr/bin/node" },
      ],
      byPid: { 3: { exe: "/usr/bin/python3", maps: [{ path: "/lib/libssl.so.3" }] }, 4: { exe: "/usr/bin/node", maps: [] } },
      want: "/proc/4/root/usr/bin/node",
    },
    "no args → known runtime, node preferred over python",
  );
  await R({}, { procs: [{ stat: { pid: 1, comm: "systemd" }, exe: "/sbin/init" }], want: DEFAULT_BIN }, "no args, no known runtime → default");

  // a graph that rejects (or wedges) must fall back, not propagate.
  eq(await resolveBin({ pid: 1 }, { query: () => Promise.reject(new Error("boom")) }), DEFAULT_BIN, "graph error → default");
}

/* ==== target enumeration (discover.discoverTargets) ================== */
{
  const graph = (procs) => ({ query: () => Promise.resolve({ data: { procs } }) });
  const proc = (pid, comm, exe, cgroup) => ({ stat: { pid, comm }, exe, cgroups: cgroup ? [{ pathname: cgroup }] : [] });

  // three node workers sharing one host binary → one target, three pids.
  let t = await discoverTargets(graph([proc(1, "node", "/usr/bin/node"), proc(2, "node", "/usr/bin/node"), proc(3, "node", "/usr/bin/node")]));
  eq(t.length, 1, "same binary → one target");
  eq(t[0].pids, [1, 2, 3], "target collects all its pids");
  eq(t[0].container, null, "host target has no container");

  // distinct runtimes → distinct targets (this is when the picker shows).
  t = await discoverTargets(graph([proc(1, "node", "/usr/bin/node"), proc(2, "python3", "/usr/bin/python3")]));
  eq(t.length, 2, "two runtimes → two targets");

  // a host node and its containerized twin are different inodes → two targets,
  // the container one carrying its id. (Non-runtime procs are ignored.)
  t = await discoverTargets(
    graph([
      proc(1, "node", "/usr/bin/node"),
      proc(2, "node", "/usr/local/bin/node", "/system.slice/docker-abc123def456aaaabbbbcccc.scope"),
      proc(9, "sshd", "/usr/sbin/sshd"),
    ]),
  );
  eq(t.length, 2, "host vs container node → two targets, sshd ignored");
  eq(
    t.find((x) => x.container)?.container?.id,
    "abc123def456",
    "container target carries its short id",
  );
}

/* ---- summary -------------------------------------------------------- */
console.log(`\n${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
yeet.exit(fail === 0 ? 0 : 1);
