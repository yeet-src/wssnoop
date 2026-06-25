/* wssnoop/view — the presentation half: turn decoded events (from decode.js)
 * into a live terminal UI. Owns every terminal concern — the `yeet:tui` render
 * loop, layout, color, truncation — so the rest of the program deals only in
 * data. Swap this module out for a different presentation (ndjson, capture to
 * disk, …) without touching capture or decode.
 *
 *   const view = createView({ bin, pid, pretty, maxlen });
 *   view.push(decodedEvent);    // one event from decoder.push()
 *   view.decodeError(err);      // a fault while decoding/rendering
 *   view.ringbufError(err);     // a transport fault from the ringbuf
 *   view.stop();                // tear the UI down (restores the terminal)
 *
 * The UI is a rolling log: each event becomes one Row, newest pinned to the
 * bottom (a `column-reverse` pane clips the oldest off the top). Events are
 * converted to plain Row records on `push` (see `toRows`); rendering just maps
 * over them. That seam — decoded event → Row record → widget — is where you'd
 * reshape the display.
 */

import { Box, Text, mount, signal } from "yeet:tui";

import { utf8, DIR_READ, DIR_WRITE } from "../lib/decode.js";

/* Solarized-ish tones, chosen to read on both light and dark terminals. */
const COL = {
  time: "#839496",
  dim: "#93a1a1",
  out: "#b58900",
  in: "#2aa198",
  msg: "#268bd2",
  control: "#dc322f",
  handshake: "#d33682",
  warn: "#dc322f",
  debug: "#657b83",
};

/* Rolling-buffer cap. Only the bottom ~viewport rows are ever on screen (the
 * rest clip off the top), so this just needs headroom over a tall terminal. */
const MAX_ROWS = 500;

function hhmmss() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

/* last 4 hex digits of the SSL pointer — enough to eyeball-group connections. */
function shortConn(ssl) {
  return (ssl & 0xffffn).toString(16).padStart(4, "0");
}

function shortText(u8) {
  const t = utf8(u8.subarray(0, 64)).replace(/[^\x20-\x7e]/g, ".");
  return u8.length > 64 ? t + "…" : t;
}

function hex(u8) {
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

function dir(d) {
  return d === DIR_WRITE
    ? { label: "OUT", color: COL.out }
    : d === DIR_READ
      ? { label: "IN", color: COL.in }
      : { label: "??", color: COL.dim };
}

export function createView({ bin, pid, maxlen = 1500 } = {}) {
  const rows = signal([]);
  const stats = signal({ events: 0, messages: 0, conns: new Set() });

  const mkRow = (r) => ({ time: hhmmss(), who: "", dir: null, tag: "", tagColor: COL.dim, size: "", body: "", bodyColor: undefined, ...r });

  function add(...rs) {
    rows.update((cur) => {
      const next = cur.length + rs.length > MAX_ROWS ? cur.slice(cur.length + rs.length - MAX_ROWS) : cur.slice();
      next.push(...rs);
      return next;
    });
  }

  /* The decoded message — the thing worth poking at — collapsed to one line. */
  function messageRow(e, msg) {
    let body, bodyColor;
    if (msg.compressed) {
      [body, bodyColor] = [`<deflate ${fmtBytes(msg.len)}>`, COL.dim];
    } else if (msg.json !== undefined) {
      const s = JSON.stringify(msg.json);
      body = s.length > maxlen ? `${s.slice(0, maxlen)}…(+${s.length - maxlen}B)` : s;
    } else if (msg.text != null) {
      body = msg.text.length > maxlen ? `${msg.text.slice(0, maxlen)}…` : msg.text;
    } else if (msg.control) {
      [body, bodyColor] = [shortText(msg.payload), COL.dim];
    } else {
      [body, bodyColor] = [`<${fmtBytes(msg.len)} binary>`, COL.dim];
    }

    return mkRow({
      who: `p${e.pid} c${shortConn(e.ssl)}`,
      dir: dir(e.dir),
      tag: msg.name,
      tagColor: msg.control ? COL.control : COL.msg,
      size: fmtBytes(msg.len),
      body,
      bodyColor,
    });
  }

  /* One decoded event → one or more Row records. */
  function toRows(ev) {
    const who = ev.pid != null ? `p${ev.pid} c${shortConn(ev.ssl)}` : "";
    switch (ev.type) {
      case "handshake": {
        const out = [
          mkRow({
            who,
            dir: dir(ev.dir),
            tag: "HSHAKE",
            tagColor: COL.handshake,
            body: ev.startLine + (ev.ext ? `  ext: ${ev.ext}` : ""),
            bodyColor: ev.deflate ? COL.warn : undefined,
          }),
        ];
        if (ev.deflate)
          out.push(mkRow({ who, tag: "!", tagColor: COL.warn, body: "permessage-deflate negotiated — payloads shown raw (no inflate yet)", bodyColor: COL.warn }));
        return out;
      }
      case "non-websocket":
        return [mkRow({ who, tag: "—", tagColor: COL.debug, body: "non-WebSocket TLS connection — ignoring body", bodyColor: COL.debug })];
      case "truncated":
        return [mkRow({ who, dir: dir(ev.dir), tag: "TRUNC", tagColor: COL.warn, body: `truncated ${fmtBytes(ev.capLen)}/${fmtBytes(ev.len)} — resyncing connection`, bodyColor: COL.warn })];
      case "debug": {
        const where = ev.stage === "handshake-done" ? `handshake done remainder=${ev.bufLen}` : `buf=${ev.bufLen}`;
        return [mkRow({ who, dir: dir(ev.dir), tag: "dbg", tagColor: COL.debug, body: `${where} head: ${hex(ev.head)}`, bodyColor: COL.debug })];
      }
      case "message":
        return [messageRow(ev, ev.msg)];
      /* "reset": SSL* address reuse — silent, like the original. */
      default:
        return [];
    }
  }

  function push(ev) {
    const rs = toRows(ev);
    if (!rs.length) return;
    add(...rs);
    stats.update((s) => ({
      events: s.events + 1,
      messages: s.messages + (ev.type === "message" ? 1 : 0),
      conns: ev.ssl != null ? s.conns.add(shortConn(ev.ssl)) && s.conns : s.conns,
    }));
  }

  function errorRow(prefix, err) {
    add(mkRow({ tag: "ERR", tagColor: COL.warn, body: `${prefix}: ${err && err.message ? err.message : err}`, bodyColor: COL.warn }));
  }
  const decodeError = (err) => errorRow("decode", err);
  const ringbufError = (err) => errorRow("ringbuf", err);

  /* ---- the view tree ------------------------------------------------- */

  const Cell = ({ width, fg, bold = false, overflow = "hidden" }, content) => (
    <Box width={width} break="none" overflow={overflow}>
      <Text fg={fg} bold={bold}>{content}</Text>
    </Box>
  );

  const Row = (r) => (
    <Box direction="row" gap={1} height={1}>
      <Cell width={12} fg={COL.time}>{r.time}</Cell>
      <Cell width={3} fg={r.dir ? r.dir.color : COL.dim}>{r.dir ? r.dir.label : ""}</Cell>
      <Cell width={14} fg={COL.dim}>{r.who}</Cell>
      <Cell width={7} fg={r.tagColor} bold>{r.tag}</Cell>
      <Cell width={6} fg={COL.dim}>{r.size}</Cell>
      <Cell width="1fr" fg={r.bodyColor} overflow="ellipsis">{r.body}</Cell>
    </Box>
  );

  const Header = () => (
    <Box direction="row" gap={1} height={1}>
      <Text bold>wssnoop</Text>
      <Text fg={COL.dim}>{`SSL_read/SSL_write in ${bin}${pid != null ? ` (pid ${pid})` : " (all pids)"}`}</Text>
      <Box width="1fr" />
      <Text fg={COL.dim}>{() => `${stats.get().conns.size} conns · ${stats.get().messages} msgs · ${stats.get().events} events`}</Text>
    </Box>
  );

  const Footer = () => (
    <Box direction="row" gap={1} height={1}>
      <Text fg={COL.dim}>{() => `${rows.get().length} rows buffered`}</Text>
      <Box width="1fr" />
      <Text fg={COL.dim}>q / Ctrl-C to quit</Text>
    </Box>
  );

  tty.on("keydown", function quit({ key }) {
    if (key === "q") yeet.exit();
  });

  /* The log pins to the bottom: `column-reverse` packs the newest-first rows
   * up from the bottom, and `overflow: hidden` clips the oldest off the top as
   * the terminal fills. `mount` frames the root at the live terminal size, so
   * the `1fr` pane reflows on resize on its own — no size math, no resize
   * listener. */
  const teardown = mount(() => (
    <Box direction="column" width="1fr" height="1fr">
      <Header />
      <Box direction="column-reverse" height="1fr" overflow="hidden">
        {() => rows.get().slice().reverse().map(Row)}
      </Box>
      <Footer />
    </Box>
  ));

  return { push, decodeError, ringbufError, stop: teardown };
}
