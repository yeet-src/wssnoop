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
import { createDecoder, DIR_WRITE, TRANSPORT_TCP } from "./lib/decode.js";
import { snoop } from "./probes/probe.js";
import { subscribeFrames, armPlaintext, disarmPlaintext } from "./probes/netconn.js";
import { focusKey, clearFocus, selectedConn, armedPids } from "./controls.js";

/* Idle eviction: a conn silent this long is dropped to free its scrollback. We
 * keep it short — closed/recycled conns shouldn't hoard memory — and instead
 * pin whatever the user is currently inspecting so it survives while open. */
const RETENTION_MS = 120_000; // 2 min
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
 * byte-keyed TimeHist). A true circular buffer: push is O(1) — no Array.shift
 * (which is O(cap) and, under a burst, blocks the event loop). `recent()`
 * materializes newest-first for the scrollback. */
function createMsgRing(cap) {
  const a = new Array(cap);
  let total = 0; // monotone push count; the live window is the last min(total,cap)
  return {
    push(rec) {
      a[total % cap] = rec;
      total += 1;
    },
    recent() {
      const n = Math.min(total, cap);
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = a[(total - 1 - i) % cap];
      return out;
    },
    /* How many retained messages satisfy `pred`, without materializing an
     * array — the per-service search-match count reads this every heartbeat. */
    count(pred) {
      const n = Math.min(total, cap);
      let hits = 0;
      for (let i = 0; i < n; i++) if (pred(a[(total - 1 - i) % cap])) hits += 1;
      return hits;
    },
    get total() {
      return total;
    },
    get size() {
      return Math.min(total, cap);
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
 * role/dest untouched. dest for the client is reconstructed scheme://host/path
 * from the Host header + the request-target on the start line; the scheme is
 * ws:// when the bytes came from the plain-TCP tap, wss:// from the TLS tap. */
function deriveRoleDest(hs) {
  const m = HTTP_REQUEST.exec(hs.startLine || "");
  if (!m) return null; // a 101 response or anything non-request: don't infer
  if (hs.dir === DIR_WRITE) {
    const path = (hs.startLine.split(/\s+/)[1] || "/").trim();
    const host = (hs.headers && hs.headers.host) || "?";
    const scheme = hs.transport === TRANSPORT_TCP ? "ws" : "wss";
    return { role: "client", dest: `${scheme}://${host}${path}` };
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
    truncated: false, /* a capture artifact, orthogonal to status (see ingest) */
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
    /* Raw bytes kept only when there's no text view (binary / inflate failure),
     * where hex is the only fallback. For a text message the hex view is
     * re-encoded from `text` on demand — don't retain derivable bytes. */
    bytes: (m.text == null || m.inflateError) && m.payload ? m.payload.slice(0, RAW_CAP) : null,
  };
}

/* The aggregation core, factored out of the tap so it's drivable without BPF.
 * Holds the registry plus the per-process and global rollups and a running
 * event count; `ingest(rec, now)` folds one decoded record in. */
export function createRegistry({ onDrop } = {}) {
  const conns = new Map(); // key -> Conn
  const groups = new Map(); // pid -> { pid, conns:Map, hist, msgUp, msgDn }
  const globalHist = createTimeHist();
  let globalMsgs = 0;
  let globalMsgUp = 0;
  let globalMsgDn = 0;
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
    onDrop?.(key); /* let the decoder forget this conn's streams + inflater */
    const g = groups.get(c.pid);
    if (g) {
      g.conns.delete(key);
      if (g.conns.size === 0) groups.delete(c.pid);
    }
  };

  /* SSL* reuse: a new connection has taken over the `pid:ssl` slot of an old
   * one (the decoder emits a "reset"). If the old conn carried WebSocket data,
   * keep it — re-key it out of the live slot so the new conn can claim it, mark
   * it closed, and its scrollback stays inspectable (evicted later by the idle
   * rule like any closed conn). A conn that never upgraded has nothing to keep,
   * so it's simply dropped. */
  let archiveSeq = 0;
  const recycleConn = (key, now) => {
    const c = conns.get(key);
    if (!c) return;
    if (!(c.msgs.total > 0 || c.role !== "?")) return dropConn(key);
    conns.delete(key);
    onDrop?.(key); /* decoder forgets the old stream; the new conn rebuilds it */
    const g = groups.get(c.pid);
    g?.conns.delete(key);
    c.key = `${key}#${++archiveSeq}`;
    if (c.status !== "closed") {
      c.status = "closed";
      c.closedAt = now;
      c.closeReason = c.closeReason || "recycled (socket reused for a new connection)";
    }
    conns.set(c.key, c);
    g?.conns.set(c.key, c);
    memberVersion += 1;
  };

  /* Drop every conn of `pid` at once — used when a process is disarmed, so its
   * rows leave the table immediately rather than idling out a window later. */
  const dropPid = (pid) => {
    const g = groups.get(pid);
    if (!g) return;
    for (const key of [...g.conns.keys()]) dropConn(key);
  };

  /* Has this pid produced any decodable WebSocket connection? The plaintext
   * fallback uses it: an armed pid that shows nothing decodable in the grace
   * window isn't plaintext ws (its wire bytes are ciphertext), so stop capturing. */
  const hasPid = (pid) => groups.has(pid);

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

    /* SSL* address reuse: the old conn is gone. Archive it (keep its data) if it
     * carried WebSocket traffic, then start clean for the new connection. */
    if (rec.type === "reset") {
      recycleConn(key, now);
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
        globalMsgUp += 1;
        addFlow(c, g, now, UP, bytes);
      } else {
        c.msgDn += 1;
        g.msgDn += 1;
        globalMsgDn += 1;
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

    /* A truncated chunk (an SSL call larger than the BPF capture cap) leaves an
     * unparseable hole — the decoder abandons this stream. This is a *capture*
     * artifact, orthogonal to the connection's lifecycle, so it's a flag, not a
     * status: the conn may well still be open, we just can't follow it anymore. */
    if (rec.type === "truncated") {
      c.truncated = true;
      c.closeReason = c.closeReason || "capture truncated (SSL call exceeded the 4 KB cap)";
    }
  }

  /* Drop conns idle past retention, then enforce the hard caps. `pinned` is the
   * conn the user is currently inspecting (by identity): it's never evicted, so
   * a connection you're reading stays put even after it closes and ages out.
   * Returns nothing — mutates the registry. Called from the heartbeat. */
  function evict(now, pinned = null) {
    /* Snapshot keys before deleting — don't mutate the Map mid-iteration. A
     * closed conn is kept just like any other until it idles past retention;
     * its lastActiveAt froze at the close, so it drops a retention window later
     * (unless it's the one being inspected). */
    for (const [key, c] of [...conns]) {
      if (c !== pinned && now - c.lastActiveAt > RETENTION_MS) dropConn(key);
    }
    if (conns.size > MAX_CONNS) {
      let excess = conns.size - MAX_CONNS;
      const order = [...conns.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt);
      for (let i = 0; excess > 0 && i < order.length; i++) {
        if (order[i] === pinned) continue;
        dropConn(order[i].key);
        excess--;
      }
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
      global: { hist: globalHist, conns: conns.size, msgs: globalMsgs, msgUp: globalMsgUp, msgDn: globalMsgDn },
      stats: { conns: conns.size, msgs: globalMsgs, events },
      memberVersion,
    };
  }

  /* A focused connection is "gone" once it's absent or has sent/seen a CLOSE —
   * at which point keeping the kernel filter on its dead SSL* would silence
   * everything. */
  const focusGone = (key) => {
    const c = conns.get(key);
    return !c || c.status === "closed" || c.truncated;
  };
  return { ingest, evict, snapshot, focusGone, dropPid, hasPid };
}

const emsg = (e) => (e && e.message ? e.message : e);

export function createSession({ binWide = null, debug = false } = {}) {
  const groups = signal([]);
  const global = signal({ hist: createTimeHist(), conns: 0, msgs: 0, msgUp: 0, msgDn: 0 });
  const stats = signal({ conns: 0, msgs: 0, events: 0 });
  const clock = signal(Date.now());
  /* A one-line health string for the chrome: a blank dashboard with no status
   * reads as broken, so a failed attach / transport fault must say so rather
   * than just showing zeros. "tracing …" once the uprobes are live, an idle
   * hint when nothing is armed. */
  const status = signal("starting…");

  /* Bound to the UI observing the session: this `from` runs the taps -> decoder
   * on first watch and detaches on last unwatch. Its own value is unused —
   * folded state lands in the registry, published on the heartbeat. */
  const tap = from(() => {
    const decoder = createDecoder({ debug });
    const reg = createRegistry({ onDrop: (key) => decoder.drop(key) });

    /* Keep decode faults local to the offending event (gotcha 12). One decoder /
     * registry serves every tap — records are keyed by (pid, ssl), so multiple
     * pid-scoped taps just fold into the same connection registry. */
    const onEvent = (e) => {
      try {
        const now = Date.now();
        for (const rec of decoder.push(e)) reg.ingest(rec, now);
      } catch {
        /* a single bad event must not wreck the stream; it's just dropped. */
      }
    };

    /* The plaintext (ws://) stream from the socket object folds into the SAME
     * decoder as the SSL taps — a record's transport tag is all that differs.
     * One subscription serves every plaintext-armed pid (demuxed by pid+sock);
     * membership is the kernel-side focus set, toggled per pid below. */
    const framesUnsub = subscribeFrames(onEvent);

    /* If an armed pid shows no decodable ws within this window after we fall back
     * to plaintext, its wire bytes aren't plaintext ws (an in-process-TLS client
     * on a non-OpenSSL stack — Go/rustls — is ciphertext here), so stop emitting
     * them: bounds the wasted capture to a short burst and marks the pid opaque. */
    const GRACE_MS = 8000;

    /* The live taps, one per armed pid, reconciled against controls.armedPids
     * each heartbeat. Each entry owns its probe session (its own focus map and
     * teardown). `binWideTap` is the separate --bin escape hatch: a single tap
     * not scoped to a pid, seeing every process that maps the binary. */
    const taps = new Map(); // pid -> { stop, setFocus, bin, err, stopped }
    let binWideTap = null;

    const refreshStatus = () => {
      const errs = [...taps.values()].map((t) => t.err).filter(Boolean);
      if (errs.length) return status.set(`tap fault: ${errs[0]}`);
      const live = taps.size + (binWideTap ? 1 : 0);
      if (live === 0) return status.set("idle · c to pick");
      const names = [...taps.values(), binWideTap]
        .filter(Boolean)
        .map((t) => t.bin && t.bin.split("/").pop())
        .filter(Boolean);
      const plaintext = [...taps.values()].filter((t) => t.plaintext).length;
      const opaque = [...taps.values()].filter((t) => t.opaque).length;
      const parts = [];
      if (names.length) parts.push([...new Set(names)].join(", "));
      if (plaintext) parts.push(`${plaintext} plaintext`);
      if (opaque) parts.push(`${opaque} opaque`);
      status.set(`tracing · ${parts.length ? parts.join(" · ") : `${live} process(es)`}`);
    };

    /* Push the current capture focus into one tap. Each probe object has its own
     * focus map; a pid-scoped tap only ever sees its own pid, so it needs just
     * the SSL* filter. The bin-wide tap sees many pids, so it takes both. */
    const applyFocus = (entry, pid) => {
      if (!entry?.setFocus) return;
      const key = focusKey.get();
      if (key == null) return entry.setFocus({ ssl: 0n, pid: 0 }); // capture-all
      const i = key.indexOf(":");
      const fpid = Number(key.slice(0, i));
      const fssl = BigInt(key.slice(i + 1));
      if (pid == null) entry.setFocus({ ssl: fssl, pid: fpid }); // bin-wide: filter both
      else entry.setFocus({ ssl: pid === fpid ? fssl : 0n, pid: 0 }); // pid-scoped: ssl only
    };
    let lastFocus = undefined;
    const syncFocus = () => {
      const key = focusKey.get();
      if (key === lastFocus) return;
      lastFocus = key;
      for (const [pid, entry] of taps) applyFocus(entry, pid);
      applyFocus(binWideTap, null);
    };

    /* The SSL uprobe couldn't attach (a non-OpenSSL process: no libssl, or the
     * symbols aren't in the exe — Go, rustls, stripped static). Fall back to the
     * socket-layer plaintext tap for this pid. If it's really plaintext ws://
     * we'll decode it; if it's in-process TLS on a non-OpenSSL stack the bytes
     * are ciphertext and the grace guard shuts the capture off as opaque. */
    const fallbackToPlaintext = (pid, entry) => {
      if (entry.stopped || entry.plaintext) return;
      entry.plaintext = true;
      armPlaintext(pid);
      entry.guard = setTimeout(() => {
        if (entry.stopped) return;
        if (!reg.hasPid(pid)) {
          disarmPlaintext(pid);
          entry.plaintext = false;
          entry.opaque = true; /* encrypted on the wire, non-OpenSSL — can't decode */
          refreshStatus();
        }
      }, GRACE_MS);
    };

    const startTap = (pid) => {
      const entry = { stop: () => {}, setFocus: null, bin: null, err: null, stopped: false, plaintext: false, opaque: false, guard: null };
      taps.set(pid, entry);
      snoop({
        pid,
        onEvent,
        onBin: (t) => ((entry.bin = t), refreshStatus()),
        onError: (e) => ((entry.err = emsg(e)), refreshStatus()),
      })
        .then((s) => {
          if (entry.stopped) return s.stop(); // disarmed before the attach resolved
          entry.stop = () => s.stop();
          entry.setFocus = s.setFocus;
          applyFocus(entry, pid);
          refreshStatus();
        })
        /* Not a fault — an unattachable uprobe is the expected non-OpenSSL case;
         * route to the plaintext tap instead of surfacing an error. */
        .catch(() => (fallbackToPlaintext(pid, entry), refreshStatus()));
    };

    const stopTap = (pid) => {
      const entry = taps.get(pid);
      if (!entry) return;
      taps.delete(pid);
      entry.stopped = true;
      if (entry.guard) clearTimeout(entry.guard);
      if (entry.plaintext) disarmPlaintext(pid);
      entry.stop();
      reg.dropPid(pid); /* its rows leave the table now, not a window later */
      refreshStatus();
    };

    /* Reconcile the live taps against the armed set (read non-reactively — this
     * runs on the heartbeat timer, so arming a process takes effect within one
     * beat, no extra machinery). */
    const reconcileTaps = () => {
      const want = new Set(armedPids.get());
      for (const pid of want) if (!taps.has(pid)) startTap(pid);
      for (const pid of [...taps.keys()]) if (!want.has(pid)) stopTap(pid);
    };

    /* The --bin escape hatch: one bin-wide tap for the whole session (it traps
     * every process using the binary — the only broad-overhead path, opted into
     * explicitly). Its events fold into the registry by their own pid. */
    if (binWide) {
      const entry = { stop: () => {}, setFocus: null, bin: null };
      snoop({
        bin: binWide,
        onEvent,
        onBin: (t) => ((entry.bin = t), refreshStatus()),
        onError: (e) => status.set(`tap fault: ${emsg(e)}`),
      })
        .then((s) => {
          entry.stop = () => s.stop();
          entry.setFocus = s.setFocus;
          binWideTap = entry;
          applyFocus(entry, null);
          refreshStatus();
        })
        .catch((e) => status.set(`probe failed: ${emsg(e)}`));
    }

    let lastMember = -1;
    const publish = () => {
      /* The heartbeat is a timer callback — an uncaught throw here escapes into
       * the runtime and can take down the whole V8 worker (closing the TTY with
       * no message). Catch it, surface it on the status line, and keep ticking. */
      try {
        reconcileTaps(); /* start/stop taps to match the armed set */
        const now = Date.now();
        reg.evict(now, selectedConn.get()); /* pin the conn being inspected */
        /* If the focused connection has closed/recycled/evicted, the kernel
         * filter would silence *everything* on its tap — release focus so the
         * table doesn't look frozen. */
        if (focusKey.get() && reg.focusGone(focusKey.get())) clearFocus();
        syncFocus();
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
      } catch (e) {
        status.set(`heartbeat fault: ${emsg(e)}`);
      }
    };

    refreshStatus();
    /* One snapshot per heartbeat, never per ringbuf event (gotcha 10). */
    const beat = setInterval(publish, HEARTBEAT_MS);
    publish();

    return () => {
      clearInterval(beat);
      framesUnsub();
      for (const [pid, entry] of taps) {
        entry.stopped = true;
        if (entry.guard) clearTimeout(entry.guard);
        if (entry.plaintext) disarmPlaintext(pid);
        entry.stop();
      }
      binWideTap?.stop();
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
