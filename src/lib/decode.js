/* wssnoop/decode — the data half: turn the raw plaintext chunks the BPF
 * program ships up (one `ssl_event` per SSL_read/SSL_write) into a stream
 * of decoded protocol events. No terminal, no colors, no I/O — every
 * function here returns plain data, so the same pipeline drives a TUI,
 * a capture-to-disk, a filter, or a test.
 *
 * The unit of work is one connection-direction: each `(pid, ssl, dir)` is
 * an independent byte stream that opens with an HTTP upgrade handshake and
 * then carries RFC-6455 frames. `createDecoder().push(event)` feeds one raw
 * chunk in and returns the decoded events it completed (zero or more):
 *
 *   { type: "handshake",     pid, tid, ssl, dir, ts, startLine, headers,
 *                            isWebSocket, ext, deflate }
 *   { type: "non-websocket", pid, tid, ssl, dir, ts }   // plain HTTPS; body skipped
 *   { type: "message",       pid, tid, ssl, dir, ts, msg }   // see Message below
 *   { type: "truncated",     pid, tid, ssl, dir, ts, capLen, len }
 *   { type: "reset",         pid, tid, ssl, dir, ts }   // SSL* address reused
 *   { type: "debug",         pid, tid, ssl, dir, ts, stage, bufLen, head }
 *
 * A Message is the decoded WebSocket message — the thing worth poking at:
 *   { name, opcode, len, payload:Uint8Array,
 *     control?:true,                 // CLOSE/PING/PONG
 *     compressed?:true,              // permessage-deflate; payload left raw
 *     text?:string, json?:any }      // set for uncompressed TEXT frames
 */

export const DIR_READ = 0; /* ingress, server -> client (unmasked) */
export const DIR_WRITE = 1; /* egress,  client -> server (masked)   */

export const OPCODES = {
  0x0: "CONT",
  0x1: "TEXT",
  0x2: "BIN",
  0x8: "CLOSE",
  0x9: "PING",
  0xa: "PONG",
};

/* ---- bytes helpers --------------------------------------------------- */

export function concat(a, b) {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/* Minimal UTF-8 decode — TextDecoder may not exist in this isolate, and
 * the payloads we care about (JSON) are UTF-8. Falls back to replacement
 * chars on malformed input rather than throwing. */
export function utf8(u8) {
  let out = "";
  for (let i = 0; i < u8.length; ) {
    const b = u8[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b >= 0xc0 && b < 0xe0 && i + 1 < u8.length) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (u8[i + 1] & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < u8.length) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((u8[i + 1] & 0x3f) << 6) | (u8[i + 2] & 0x3f),
      );
      i += 3;
    } else if (b >= 0xf0 && i + 3 < u8.length) {
      const cp =
        ((b & 0x07) << 18) |
        ((u8[i + 1] & 0x3f) << 12) |
        ((u8[i + 2] & 0x3f) << 6) |
        (u8[i + 3] & 0x3f);
      out += cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
      i += 4;
    } else {
      out += "�";
      i += 1;
    }
  }
  return out;
}

/* ---- RFC-6455 frame parser ------------------------------------------ */

/* Parse one frame off the front of `buf`. Returns the decoded frame plus
 * how many bytes it consumed, or null when more bytes are needed. The
 * payload is unmasked here if the MASK bit is set (client->server frames
 * are masked; server->client are not). */
export function parseFrame(buf) {
  if (buf.length < 2) return null;

  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const rsv1 = (b0 & 0x40) !== 0; /* set => permessage-deflate compressed */
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;

  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = (buf[off] << 8) | buf[off + 1];
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset + off, 8);
    len = dv.getUint32(0) * 2 ** 32 + dv.getUint32(4);
    off += 8;
  }

  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }

  if (buf.length < off + len) return null;

  let payload = buf.slice(off, off + len); /* copy: buf gets re-sliced */
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];

  return {
    fin,
    rsv1,
    opcode,
    masked,
    maskKey: mask ? Array.from(mask) : null,
    len,
    payload,
    consumed: off + len,
  };
}

/* ---- HTTP upgrade handshake ----------------------------------------- */

const HTTP_VERBS = /^(GET|POST|PUT|HEAD|HTTP)/;

/* Decide what the front of a fresh stream is. If it opens with an HTTP
 * token we parse the handshake; otherwise we likely attached mid-stream
 * (connection predates the snoop) and jump straight to frame parsing. */
function looksHttp(buf) {
  return HTTP_VERBS.test(utf8(buf.subarray(0, 8)));
}

/* Parse the request/status line + headers off the front of `buf`. Returns
 * null until the full header block (through the blank \r\n\r\n) is buffered. */
function parseHandshake(buf) {
  let term = -1;
  for (let i = 3; i < buf.length; i++) {
    if (
      buf[i - 3] === 0x0d &&
      buf[i - 2] === 0x0a &&
      buf[i - 1] === 0x0d &&
      buf[i] === 0x0a
    ) {
      term = i + 1;
      break;
    }
  }
  if (term < 0) return null; /* wait for more */

  const header = utf8(buf.subarray(0, term));
  const lines = header.split("\r\n").filter(Boolean);
  const startLine = lines[0] || "";
  const headers = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }

  const isWebSocket = /websocket/i.test(headers["upgrade"] || "") || /\b101\b/.test(startLine);
  const ext = headers["sec-websocket-extensions"];
  const deflate = !!ext && /permessage-deflate/i.test(ext);

  return { startLine, headers, isWebSocket, ext, deflate, consumed: term };
}

/* ---- frame -> message assembly -------------------------------------- */

/* Assemble fragmented messages, then surface complete ones. Returns the
 * finished message object, or null for an interim fragment / stray
 * continuation we don't elevate. */
function onFrame(s, f) {
  const name = OPCODES[f.opcode] || `0x${f.opcode.toString(16)}`;

  /* Control frames (8/9/A) are standalone and never fragmented. */
  if (f.opcode >= 0x8) {
    return { name, opcode: f.opcode, control: true, len: f.len, payload: f.payload };
  }

  /* Data frames: opcode 0x1/0x2 start a message; 0x0 continues it. */
  if (f.opcode === 0x0) {
    if (!s.frag) return null; /* stray continuation — ignore */
    s.frag.chunks.push(f.payload);
    if (!f.fin) return null;
    const full = s.frag;
    s.frag = null;
    return finishMessage(full.opcode, full.rsv1, full.chunks);
  }

  if (!f.fin) {
    s.frag = { opcode: f.opcode, rsv1: f.rsv1, chunks: [f.payload] };
    return null;
  }
  return finishMessage(f.opcode, f.rsv1, [f.payload]);
}

function finishMessage(opcode, rsv1, chunks) {
  let payload = chunks[0];
  for (let i = 1; i < chunks.length; i++) payload = concat(payload, chunks[i]);

  const msg = {
    name: OPCODES[opcode] || `0x${opcode.toString(16)}`,
    opcode,
    compressed: rsv1,
    len: payload.length,
    payload,
    text: null,
    json: undefined,
  };

  if (rsv1) return msg; /* compressed — leave bytes raw for now */
  if (opcode === 0x1) {
    msg.text = utf8(payload);
    try {
      msg.json = JSON.parse(msg.text);
    } catch {
      /* not JSON; text still set */
    }
  }
  return msg;
}

/* ---- the decoder ----------------------------------------------------- */

function freshState() {
  return { phase: "handshake", buf: new Uint8Array(0), frag: null, kind: null };
}

/* createDecoder() owns the per-connection state. push(event) ingests one
 * raw `ssl_event` and returns the decoded events it completed. */
export function createDecoder({ debug = false } = {}) {
  /* Keyed by `${pid}:${ssl}:${dir}` — each direction is its own stream. */
  const conns = new Map();

  const ctx = (e) => ({ pid: e.pid, tid: e.tid, ssl: e.ssl, dir: e.dir, ts: e.ts });
  const ev = (e, extra) => ({ ...ctx(e), ...extra });
  const dbg = (e, s, stage) =>
    ev(e, { type: "debug", stage, bufLen: s.buf.length, head: s.buf.slice(0, 16) });

  function push(e) {
    const out = [];
    const key = `${e.pid}:${e.ssl}:${e.dir}`;
    let s = conns.get(key) || freshState();
    conns.set(key, s);

    const chunk = e.data.subarray(0, e.cap_len);

    /* OpenSSL reuses freed SSL* addresses, so a reconnect can land on a key
     * we've already advanced. A fresh HTTP handshake mid-stream is the tell —
     * reset, or we'd concatenate two different connections and desync. */
    if (s.phase !== "handshake" && looksHttp(chunk)) {
      s = freshState();
      conns.set(key, s);
      out.push(ev(e, { type: "reset" }));
    }

    if (s.phase === "done") return out;

    if (e.cap_len < e.len) {
      /* A truncated chunk leaves a hole in the byte stream we can't parse
       * across, so drop this connection's framing rather than emit garbage.
       * Bump CHUNK in wssnoop.bpf.c if this fires a lot. */
      out.push(ev(e, { type: "truncated", capLen: e.cap_len, len: e.len }));
      s.phase = "done";
      return out;
    }

    s.buf = concat(s.buf, chunk);

    if (s.phase === "handshake") {
      if (s.kind == null && s.buf.length >= 8) s.kind = looksHttp(s.buf) ? "http" : "frames";
      if (s.kind === "frames") {
        s.phase = "frames";
      } else {
        const hs = parseHandshake(s.buf);
        if (!hs) return out; /* wait for more */
        s.buf = s.buf.slice(hs.consumed);
        out.push(
          ev(e, {
            type: "handshake",
            startLine: hs.startLine,
            headers: hs.headers,
            isWebSocket: hs.isWebSocket,
            ext: hs.ext,
            deflate: hs.deflate,
          }),
        );
        if (debug) out.push(dbg(e, s, "handshake-done"));
        s.phase = hs.isWebSocket ? "frames" : "done"; /* non-WS (plain HTTPS): stop */
        if (!hs.isWebSocket) {
          out.push(ev(e, { type: "non-websocket" }));
          return out;
        }
      }
    }

    /* frames phase: consume as many complete frames as buffered. */
    for (;;) {
      if (debug && s.buf.length) out.push(dbg(e, s, "frames"));
      const f = parseFrame(s.buf);
      if (!f) break;
      s.buf = s.buf.slice(f.consumed);
      const msg = onFrame(s, f);
      if (msg) out.push(ev(e, { type: "message", msg }));
    }
    return out;
  }

  return { push };
}
