/* wssnoop/state — the seam between the imperative tap and the reactive UI,
 * rebuilt around *connections over time* rather than a flat event log.
 *
 * Capture (probes/probe.js) is a ringbuf subscription; decode (lib/decode.js) is
 * a stateful stream transducer keyed by (pid, ssl, DIR) — each direction its own
 * byte stream. The UI reads values that change over time, grouped by process.
 * This module bridges the two: it folds the decode stream into a *registry* of
 * WebSocket connections keyed `${pid}:${ssl}` (the two directions of one socket
 * merged), each carrying a TimeHist of its byte flow, and rolls those up into
 * per-process and global aggregates.
 *
 * Denotationally the registry is a function (pid, ssl) → Conn, partitioned into
 * Groups by pid; a Conn is the live state of one WebSocket (role, dest, message
 * counts, a TimeHist). The decode stream mutates that function; a single ~500ms
 * heartbeat samples it into snapshot signals the UI watches. Sampling lives here
 * (one snapshot per heartbeat), not under the ringbuf firehose — a busy socket
 * fires thousands of times a second, but the screen updates twice a second.
 *
 *   const { groups, global, stats, clock } = createSession({ bin, pid, debug });
 *   // groups: signal< Group[] >    per-process, RAW order (UI sorts/filters)
 *   // global: signal< { hist, conns, msgs } >    whole-host rollup
 *   // stats:  signal< { conns, msgs, events } >  header counters
 *   // clock:  signal< number >     Date.now(), ticks each heartbeat (sparklines reflow)
 *
 * Direction: UP = egress = SSL_write = DIR_WRITE = 1; DOWN = ingress =
 * SSL_read = DIR_READ = 0. Only WebSocket connections are kept — a
 * `non-websocket` (plain HTTPS) event drops the conn from the registry.
 *
 * The tap's lifecycle is tied to the UI watching it: snoop attaches on first
 * watch and detaches on last unwatch (from()). A failed attach or a decode
 * fault degrades to a status line via the `stats`/`global` snapshots staying
 * alive — errors never paint over the screen (gotcha 12). */

import { computed, from, signal } from "yeet:tui";

import { createTimeHist, DOWN, UP } from "./lib/timehist.js";
import { createDecoder, DIR_WRITE } from "./lib/decode.js";
import { snoop } from "./probes/probe.js";
import { focusKey } from "./controls.js";

/* Idle eviction matches the max viz range — a conn silent longer than the
 * longest sparkline window can show carries no visible data, so drop it. */
const RETENTION_MS = 1_800_000; // 30 min == the longest viz window (900 buckets * 2s)
const CLOSE_GRACE_MS = 20_000; // keep a closed conn visible briefly, then drop it
const HEARTBEAT_MS = 500;

/* Hard memory backstop on top of idle eviction (a pathological host could open
 * sockets faster than they idle out). When exceeded we drop the least-recently
 * active conns / smallest groups, oldest first. */
const MAX_CONNS = 2000;
const MAX_GROUPS = 256;

/* Per-connection message scrollback the inspector reads. Bounded by count: a
 * busy socket fires thousands of frames a second, so we keep only the most
 * recent MSG_CAP, and cap retained raw bytes per message (text/json are kept
 * whole — they're the small JSON payloads we care about; the raw slice is only
 * for binary / inflate-failure hex). */
const MSG_CAP = 300;
const RAW_CAP = 2048;

const HTTP_REQUEST = /^(GET|POST|PUT|HEAD|OPTIONS|DELETE|PATCH)\b/;

/* A count-bounded ring of retained messages (the message-keyed analogue of the
 * byte-keyed TimeHist). `recent()` returns newest-first for the scrollback. */
function createMsgRing(cap) {
  const a = [];
  let total = 0;
  return {
    push(rec) {
      a.push(rec);
      total += 1;
      if (a.length > cap) a.shift();
    },
    recent() {
      return a.slice().reverse();
    },
    get total() {
      return total;
    },
    get size() {
      return a.length;
    },
  };
}

/* short connection id for display: last 4 hex digits of the SSL* pointer. */
const shortId = (ssl) => {
  const hex = (typeof ssl === "bigint" ? ssl : BigInt(ssl)).toString(16);
  return hex.length <= 4 ? hex : hex.slice(-4);
};

/* Role/dest from a handshake. The *client* sends the upgrade request (an HTTP
 * verb on the start line) on its egress stream (DIR_WRITE); the *server* sees
 * that same request arrive on its ingress (DIR_READ). The `HTTP/1.1 101`
 * response is not a request line, so it never matches HTTP_REQUEST and leaves
 * role/dest untouched. dest for the client is reconstructed wss://host/path
 * from the Host header + the request-target on the start line. */
function deriveRoleDest(hs) {
  const m = HTTP_REQUEST.exec(hs.startLine || "");
  if (!m) return null; // a 101 response or anything non-request: don't infer
  if (hs.dir === DIR_WRITE) {
    const path = (hs.startLine.split(/\s+/)[1] || "/").trim();
    const host = (hs.headers && hs.headers.host) || "?";
    return { role: "client", dest: `wss://${host}${path}` };
  }
  return { role: "server", dest: "?" };
}

/* A fresh Conn, role/dest unknown until a handshake teaches us otherwise. The
 * extra fields are the discoverable metadata the inspector surfaces: negotiated
 * identity (headers/subprotocol/extensions/origin), lifecycle status + close
 * detail, and running aggregates (opcode histogram, on-wire vs inflated bytes
 * for the compression ratio). */
function freshConn(pid, ssl, now) {
  return {
    key: `${pid}:${ssl}`,
    pid,
    ssl,
    conn: shortId(ssl),
    role: "?",
    dest: "?",
    deflate: null, /* RFC-7692 params, once a handshake negotiates them */
    headers: {}, /* merged handshake headers (both directions) */
    subprotocol: null,
    extensions: null,
    origin: null,
    status: "open", /* open → closing → closed (from a CLOSE frame) */
    closeCode: null,
    closeReason: null,
    closedAt: null,
    startedAt: now,
    lastActiveAt: now,
    msgUp: 0,
    msgDn: 0,
    opcodes: {}, /* name -> count */
    wireBytes: 0, /* on-wire (compressed) data bytes */
    inflatedBytes: 0, /* decoded data bytes — ratio gives the compression */
    hist: createTimeHist(),
    msgs: createMsgRing(MSG_CAP), /* decoded scrollback for the inspector */
  };
}

/* Project a decoded Message (lib/decode.js) into the slimmed record the
 * inspector retains. `text`/`json` (already inflated by the decoder, deflate and
 * all) are kept whole — they're the payloads worth reading; the raw byte slice
 * is capped and kept only for non-text frames and inflate failures, where a hex
 * view is the fallback. `compressed`/`inflateError` carry the deflate story. */
function retainMsg(c, dir, m, now) {
  return {
    seq: c.msgs.total, /* monotone, stable scroll/expand key */
    at: now,
    dir,
    name: m.name,
    opcode: m.opcode,
    len: m.len,
    wireLen: m.wireLen ?? m.len, /* on-wire (compressed) size */
    frames: m.frames ?? 1, /* fragmentation: frames per message */
    masked: !!m.masked,
    fin: m.fin !== false,
    control: !!m.control,
    compressed: !!m.compressed,
    inflateError: m.inflateError || null,
    closeCode: m.closeCode ?? null,
    closeReason: m.closeReason ?? null,
    text: m.text ?? null,
    json: m.json,
    /* raw payload bytes (capped) kept for every message so the inspector can
     * show a hex view even when the message decoded cleanly. */
    bytes: m.payload ? m.payload.slice(0, RAW_CAP) : null,
  };
}

/* The aggregation core, factored out of the tap so it's drivable without BPF.
 * Holds the registry plus the per-process and global rollups and a running
 * event count; `ingest(rec, now)` folds one decoded record in. */
export function createRegistry() {
  const conns = new Map(); // key -> Conn
  const groups = new Map(); // pid -> { pid, conns:Map, hist, msgUp, msgDn }
  const globalHist = createTimeHist();
  let globalMsgs = 0;
  let events = 0;
  /* Bumped only when the *set* of conns/groups changes (create or drop). The
   * session republishes the groups snapshot only when this moves, so the UI
   * rebuilds row structure on membership change — never on a mere heartbeat —
   * while live conn objects + the clock drive the per-row content. */
  let memberVersion = 0;

  const groupFor = (pid) => {
    let g = groups.get(pid);
    if (!g) {
      g = { pid, conns: new Map(), hist: createTimeHist(), msgUp: 0, msgDn: 0 };
      groups.set(pid, g);
    }
    return g;
  };

  const dropConn = (key) => {
    const c = conns.get(key);
    if (!c) return;
    conns.delete(key);
    memberVersion += 1;
    const g = groups.get(c.pid);
    if (g) {
      g.conns.delete(key);
      if (g.conns.size === 0) groups.delete(c.pid);
    }
  };

  /* Record `bytes` of flow in direction `dir` across conn / process / global
   * histograms at time `now`. */
  const addFlow = (c, g, now, dir, bytes) => {
    if (!(bytes > 0)) return;
    c.hist.add(now, dir, bytes);
    g.hist.add(now, dir, bytes);
    globalHist.add(now, dir, bytes);
  };

  function ingest(rec, now) {
    if (rec == null || rec.ssl == null || rec.pid == null) return;
    events += 1;

    const key = `${rec.pid}:${rec.ssl}`;

    /* Plain HTTPS on this SSL* — not a WebSocket; forget the connection. */
    if (rec.type === "non-websocket") {
      dropConn(key);
      return;
    }

    /* SSL* address reuse: the old conn is gone, start clean. */
    if (rec.type === "reset") {
      dropConn(key);
      return;
    }

    /* Only event types below this point create / touch a live conn. We treat
     * any byte-bearing protocol event as keeping the socket alive. */
    if (
      rec.type !== "handshake" &&
      rec.type !== "message" &&
      rec.type !== "truncated"
    ) {
      return; // debug etc.: counted as an event, no conn effect
    }

    let c = conns.get(key);
    if (!c) {
      c = freshConn(rec.pid, rec.ssl, now);
      conns.set(key, c);
      groupFor(rec.pid).conns.set(key, c);
      memberVersion += 1;
    }
    const g = groupFor(rec.pid);
    c.lastActiveAt = now;

    if (rec.type === "handshake") {
      if (rec.startedAt == null) c.startedAt = c.startedAt || now;
      if (rec.deflate && !c.deflate) c.deflate = rec.deflate; /* either direction */
      if (rec.headers) {
        c.headers = { ...c.headers, ...rec.headers }; /* merge request + 101 response */
        c.subprotocol = c.headers["sec-websocket-protocol"] ?? c.subprotocol;
        c.extensions = c.headers["sec-websocket-extensions"] ?? c.extensions;
        c.origin = c.headers["origin"] ?? c.origin;
      }
      const rd = deriveRoleDest(rec);
      if (rd) {
        c.role = rd.role;
        c.dest = rd.dest;
      }
      return;
    }

    if (rec.type === "message") {
      const m = rec.msg;
      const bytes = m ? Number(m.len) || 0 : 0;
      if (rec.dir === DIR_WRITE) {
        c.msgUp += 1;
        g.msgUp += 1;
        addFlow(c, g, now, UP, bytes);
      } else {
        c.msgDn += 1;
        g.msgDn += 1;
        addFlow(c, g, now, DOWN, bytes);
      }
      globalMsgs += 1;
      if (m) {
        c.opcodes[m.name] = (c.opcodes[m.name] || 0) + 1;
        if (!m.control) {
          c.wireBytes += Number(m.wireLen) || 0;
          c.inflatedBytes += Number(m.len) || 0;
        }
        /* A CLOSE frame moves the connection to closed; record the code/reason
         * and stamp closedAt so the row briefly shows the lifecycle end. */
        if (m.opcode === 0x8) {
          c.status = "closed";
          c.closeCode = m.closeCode ?? c.closeCode;
          c.closeReason = m.closeReason ?? c.closeReason;
          c.closedAt = now;
        }
        c.msgs.push(retainMsg(c, rec.dir, m, now));
      }
      return;
    }

    // truncated: keeps the conn alive (lastActiveAt bumped) but no byte signal.
  }

  /* Drop conns idle past retention, then enforce the hard caps. Returns nothing
   * — mutates the registry. Called from the heartbeat before snapshotting. */
  function evict(now) {
    for (const [key, c] of conns) {
      if (c.status === "closed" && c.closedAt != null && now - c.closedAt > CLOSE_GRACE_MS) dropConn(key);
      else if (now - c.lastActiveAt > RETENTION_MS) dropConn(key);
    }
    if (conns.size > MAX_CONNS) {
      const order = [...conns.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt);
      for (let i = 0; i < conns.size - MAX_CONNS && i < order.length; i++) dropConn(order[i].key);
    }
    if (groups.size > MAX_GROUPS) {
      const order = [...groups.values()].sort((a, b) => a.conns.size - b.conns.size);
      const excess = groups.size - MAX_GROUPS;
      for (let i = 0; i < excess && i < order.length; i++) {
        for (const key of order[i].conns.keys()) dropConn(key);
      }
    }
  }

  /* Materialize the current registry into the plain shapes the UI reads. RAW
   * order (insertion) — the UI applies filter/sort/slice. */
  function snapshot() {
    const groupList = [];
    for (const g of groups.values()) {
      groupList.push({
        pid: g.pid,
        conns: [...g.conns.values()],
        hist: g.hist,
        msgUp: g.msgUp,
        msgDn: g.msgDn,
      });
    }
    return {
      groups: groupList,
      global: { hist: globalHist, conns: conns.size, msgs: globalMsgs },
      stats: { conns: conns.size, msgs: globalMsgs, events },
      memberVersion,
    };
  }

  return { ingest, evict, snapshot };
}

export function createSession({ bin, pid, debug = false } = {}) {
  const groups = signal([]);
  const global = signal({ hist: createTimeHist(), conns: 0, msgs: 0 });
  const stats = signal({ conns: 0, msgs: 0, events: 0 });
  const clock = signal(Date.now());
  /* A one-line health string for the chrome: a blank dashboard with no status
   * reads as broken, so a failed attach / transport fault must say so rather
   * than just showing zeros. "tracing" once the uprobes are live. */
  const status = signal("starting…");

  /* Bound to the UI observing the session: this `from` runs snoop -> decoder on
   * first watch and detaches on last unwatch. Its own value is unused — folded
   * state lands in the registry, published on the heartbeat. */
  const tap = from(() => {
    const decoder = createDecoder({ debug });
    const reg = createRegistry();

    /* The probe's live capture-filter setter, once the attach resolves. The UI
     * sets controls.focusKey (`${pid}:${ssl}` | null); we mirror it into the
     * kernel here — the tap owns the probe session, so this control→kernel
     * bridge belongs at this seam. */
    let focusFn = null;
    let lastFocus = undefined;
    const syncFocus = () => {
      if (!focusFn) return;
      const key = focusKey.get();
      if (key === lastFocus) return;
      lastFocus = key;
      if (key == null) {
        focusFn({ ssl: 0n, pid: 0 });
      } else {
        const i = key.indexOf(":");
        focusFn({ ssl: BigInt(key.slice(i + 1)), pid: Number(key.slice(0, i)) });
      }
    };

    /* error records degrade to the stats line: bump the event counter and let
     * the header surface it. We keep a small status string for the header. */
    let lastMember = -1;
    const publish = () => {
      const now = Date.now();
      syncFocus();
      reg.evict(now);
      const snap = reg.snapshot();
      /* Republish the group structure only when membership changed; the clock
       * tick drives per-row content (sparklines, counts) off the live conn
       * objects, so steady traffic doesn't rebuild the tree (gotcha 10). */
      if (snap.memberVersion !== lastMember) {
        groups.set(snap.groups);
        lastMember = snap.memberVersion;
      }
      global.set(snap.global);
      stats.set(snap.stats);
      clock.set(now);
    };

    /* Keep decode faults local to the offending event (gotcha 12). */
    const onEvent = (e) => {
      try {
        const now = Date.now();
        for (const rec of decoder.push(e)) reg.ingest(rec, now);
      } catch {
        /* a single bad event must not wreck the stream; it's just dropped. */
      }
    };

    /* A failed attach (missing BTF, no root, bad bind) becomes a status line
     * rather than an unhandled rejection painted over the screen — the session
     * produces no data and the chrome says why. */
    const session = snoop({
      bin,
      pid,
      onEvent,
      onError: (e) => status.set(`tap fault: ${e && e.message ? e.message : e}`),
    })
      .then((s) => {
        status.set("tracing");
        focusFn = s.setFocus; /* enable the capture-focus control */
        syncFocus();
        return s;
      })
      .catch((e) => {
        status.set(`probe failed: ${e && e.message ? e.message : e}`);
        return { stop() {} };
      });

    /* One snapshot per heartbeat, never per ringbuf event (gotcha 10). */
    const beat = setInterval(publish, HEARTBEAT_MS);
    publish();

    return () => {
      clearInterval(beat);
      session.then((s) => s.stop());
    };
  }, null);

  /* Reading a snapshot registers a watch on `tap` (which starts/stops snoop) and
   * returns the live value. `tap` never changes, so it adds no re-renders. */
  const observe = (value) => computed(() => (tap.get(), value.get()));

  return {
    groups: observe(groups),
    global: observe(global),
    stats: observe(stats),
    clock: observe(clock),
    status: observe(status),
  };
}

/* Standalone aggregation check — no BPF, no signals. Synthesizes decode-style
 * records across 2 pids and a few SSL* pointers (a client handshake, a server
 * handshake, messages both directions, a non-websocket that must vanish), drives
 * the registry directly, and dumps a groups snapshot with a BigInt-safe JSON
 * replacer. Run: `yeet run src/state.js`. */
if (import.meta.main) {
  const reg = createRegistry();
  const t0 = 1_700_000_000_000;
  const ssl = (n) => BigInt("0x7f0000a" + n.toString(16).padStart(3, "0"));

  const A = 4242,
    B = 9001;
  const sClient = ssl(1), // pid A: we are the client
    sServer = ssl(2), // pid A: we are the server
    sPlain = ssl(3), // pid A: plain HTTPS, must be dropped
    sMid = ssl(4); // pid B: mid-stream attach, role/dest unknown

  const events = [
    // pid A, client: egress GET upgrade → dest from Host + path
    {
      type: "handshake",
      pid: A,
      ssl: sClient,
      dir: 1,
      startLine: "GET /ws/v2?token=abc HTTP/1.1",
      headers: { host: "stream.example.com", upgrade: "websocket" },
    },
    { type: "message", pid: A, ssl: sClient, dir: 1, msg: { name: "TEXT", len: 120 } },
    { type: "message", pid: A, ssl: sClient, dir: 0, msg: { name: "TEXT", len: 4096 } },
    { type: "message", pid: A, ssl: sClient, dir: 0, msg: { name: "TEXT", len: 2048 } },

    // pid A, server: the upgrade request arrives on ingress (DIR_READ)
    {
      type: "handshake",
      pid: A,
      ssl: sServer,
      dir: 0,
      startLine: "GET /socket HTTP/1.1",
      headers: { host: "us.local", upgrade: "websocket" },
    },
    { type: "message", pid: A, ssl: sServer, dir: 0, msg: { name: "BIN", len: 64 } },
    { type: "message", pid: A, ssl: sServer, dir: 1, msg: { name: "BIN", len: 512 } },

    // pid A, plain HTTPS: handshake then non-websocket → conn must be dropped
    {
      type: "handshake",
      pid: A,
      ssl: sPlain,
      dir: 1,
      startLine: "GET /api/health HTTP/1.1",
      headers: { host: "rest.example.com" },
    },
    { type: "non-websocket", pid: A, ssl: sPlain, dir: 1 },

    // pid B, mid-stream attach: frames with no handshake → role/dest "?"
    { type: "message", pid: B, ssl: sMid, dir: 0, msg: { name: "TEXT", len: 900 } },
    { type: "message", pid: B, ssl: sMid, dir: 1, msg: { name: "PING", len: 0 } },
    { type: "message", pid: B, ssl: sMid, dir: 1, msg: { name: "TEXT", len: 300 } },
  ];

  events.forEach((e, i) => reg.ingest(e, t0 + i * 50));
  reg.evict(t0 + events.length * 50);
  const snap = reg.snapshot();

  /* Project the live TimeHist objects to something printable + BigInt-safe. */
  const view = {
    stats: snap.stats,
    global: {
      conns: snap.global.conns,
      msgs: snap.global.msgs,
      totalUp: snap.global.hist.totalUp,
      totalDown: snap.global.hist.totalDown,
    },
    groups: snap.groups.map((g) => ({
      pid: g.pid,
      msgUp: g.msgUp,
      msgDn: g.msgDn,
      conns: g.conns.map((c) => ({
        key: c.key,
        conn: c.conn,
        role: c.role,
        dest: c.dest,
        msgUp: c.msgUp,
        msgDn: c.msgDn,
        up: c.hist.totalUp,
        down: c.hist.totalDown,
      })),
    })),
  };

  const replacer = (_k, v) => (typeof v === "bigint" ? `${v}n` : v);
  console.log(JSON.stringify(view, replacer, 2));
}
