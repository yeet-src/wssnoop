/* wssnoop/inspector — the drill-down view. Clicking a connection row sets
 * controls.selected to its key; root mounts this over the body as a full-screen
 * panel (the wide JSON payloads want the room) with a "‹ back" button and Esc to
 * return. It shows the connection's details and a live, scrollable log of its
 * decoded messages — newest first, click one to expand its payload.
 *
 * The decoder (lib/decode.js) has already inflated permessage-deflate and parsed
 * TEXT/JSON by the time state.js retains a message, so expanding a compressed
 * frame shows the *decompressed* content; the ⚙ badge marks that it arrived
 * compressed, and a ⚠ badge (with the raw bytes) marks an inflate failure.
 *
 * It reads the clock (`now`) in its own thunks, so counts and the message log
 * stay live without the caller re-rendering; it resolves `selected` against the
 * live registry each frame, so a closed/evicted connection degrades to a notice
 * rather than a stale freeze. Root memoizes this node on `selected`, so it
 * mounts once per open (not per heartbeat) and its internal thunks drive the
 * liveness. View-state (scroll/expand/freeze) lives in controls.js so it
 * survives a close/reopen cleanly; `inspect` resets it for a new connection. */

import { Box, Text, Layer, bold, italic, fg, computed } from "yeet:tui";
import { pipe } from "yeet:helpers";

import Button from "../kit/ui/button.jsx";
import Pair from "../kit/ui/pair.jsx";
import { tip, flash, hoverTip, hoverBg } from "../kit/ui/tooltip.js";
import { COL, roleColor, jsonColor } from "../palette.js";
import { fmtBytes, fmtAgo } from "../kit/fmt.js";
import { hexDump } from "../kit/hexdump.js";
import { jsonTokens, parseJson } from "../kit/json.js";
import { utf8Bytes } from "../kit/bytes.js";
import { toJsonl, messageJson } from "../lib/export.js";
import { compile } from "../kit/query.js";
import { messageText } from "../lib/message.js";
import { DIR_WRITE } from "../lib/decode.js";
import { destOf, destTip, peerInfo } from "../probes/peers.js";
import {
  selected,
  selectedConn,
  closeInspector,
  search,
  inspectScroll as scroll,
  inspectScrollAt as scrollAt,
  inspectExpanded as expanded,
  inspectFrozen as frozen,
  inspectSnap as snap,
  inspectDetails as details,
  inspectRaw as raw,
  toggleDetails,
  toggleRaw,
  setFocus,
  clearFocus,
  isFocused,
} from "../controls.js";

/* The compiled query predicate, recompiled only when the query changes. Plain
 * text is a substring over the message haystack (opcode + text + inflate error);
 * `$.path OP value` terms test the decoded JSON body (see kit/query.js). */
const matcher = computed(() => compile(search.get(), { text: messageText }));

/* OSC52 clipboard (works across the VM / SSH); no-op if unavailable. */
const copy = (text, note) => {
  try {
    tty.clipboard.writeText(text);
    flash(note);
  } catch (e) {
    flash(`copy failed: ${e?.message ?? e}`);
  }
};

const RULE = "─".repeat(400);
const MAX_LINES = 400; /* cap an expanded payload so a huge frame can't run away */
const SCROLLBAR_FADE_MS = 1200; /* how long the overlay scrollbar lingers after a scroll */

const ageOf = (now, at) => `${fmtAgo(now - at)}`.padStart(4);
const arrow = (dir) => (dir === DIR_WRITE ? fg(COL.out)("↑") : fg(COL.in)("↓"));
const badges = (rec) =>
  (rec.inflateError ? fg(COL.warn)("⚠") : rec.compressed ? fg(COL.in)("⚙") : " ");

/* One message → its collapsed preview text. The text IS the JSON string, so the
 * one-liner needs no parse — cheap enough to run per visible row per frame. */
function preview(rec) {
  if (rec.inflateError) return fg(COL.warn)(`inflate failed: ${rec.inflateError}`);
  let s;
  if (rec.text != null) s = oneLine(rec.text);
  else if (rec.control) s = `(${rec.name})`;
  else s = `${rec.len} bytes`;
  return fg(COL.dim)(s);
}

const oneLine = (s) => (s == null ? "" : s.replace(/\s+/g, " ").trim());

/* An inline indicator that explains itself: it renders its glyph/label and
 * carries a tip(), so hovering *that one widget* puts its meaning in the
 * minibuffer. This is how a line gets one tip per meaningful symbol instead of
 * a single catch-all tip on the whole row. Height-1 so a row of them aligns. */
const Tag = (title, ...content) => (
  <Box direction="row" width="fit" height={1} break="none" {...tip(title)}>
    <Text break="none">{content}</Text>
  </Box>
);

/* A scroll affordance: a 3-row opacity gradient fading the log into the panel
 * background at one edge, shown only when there's more content past that edge.
 * It's three height-1 boxes of increasing alpha (sheer → near-opaque toward the
 * very edge) z-stacked over the message text — an rgba bg dims the content
 * beneath it, the same trick the scrim uses to dim the table. The 8-digit hex
 * is #RRGGBBAA over COL.panel (#11161f). */
const EdgeFade = ({ edge }) => {
  const rows = edge === "top" ? [...COL.panelFade].reverse() : COL.panelFade; // opaque at the edge
  return (
    <Box
      left={0}
      right={0}
      {...(edge === "top" ? { top: 0 } : { bottom: 0 })}
      height={3}
      z={1}
      direction="column"
    >
      {rows.map((c) => (
        <Box height={1} bg={c} />
      ))}
    </Box>
  );
};

export default function Inspector({ groups, now, size }) {
  let count = 0; /* messages last rendered — clamps the wheel */
  /* Visible message rows = the log viewport height (the page size for scroll and
   * fade math). The flush full-height panel's chrome above the log is title(1) +
   * summary(2) + actions(1) + rule(1), the footer(1) below, and the toolbar(~3)
   * the panel sits under ≈ rows-10. The list overfills past this and relies on
   * overflow:hidden, so a small misestimate clips cleanly instead of gapping. */
  const viewH = () => Math.max(4, size.get().rows - 10);
  const OVERFILL = 3; /* extra rows rendered so text always reaches the bottom edge */

  /* Follow vs. paused (state in controls.js, see note there). A busy socket
   * prepends faster than you can read, so the moment you scroll or expand we
   * pause and render a *frozen snapshot* — an array of the message refs at that
   * instant, which survive even as the ring rolls them off, so the view holds
   * still. "live" resumes the tail. */

  /* Resolve the selected key against the live registry; null = closed. */
  /* Resolve the inspected connection — by identity, not just key. OpenSSL reuses
   * freed SSL* pointers, so a different connection can appear under the same key;
   * returning it would silently rebind the inspector to the wrong stream. We
   * match the exact object we opened, so a reused key reads as "closed". */
  const lookup = () => {
    const want = selectedConn.get();
    const key = selected.get();
    for (const g of groups.get()) {
      const c = g.conns.find((x) => x.key === key);
      if (c) return c === want ? c : null;
    }
    return null;
  };

  const liveList = () => lookup()?.msgs.recent() ?? [];
  const pause = () => {
    if (!frozen.get()) snap.set(liveList());
    frozen.set(true);
  };
  const goLive = () => {
    frozen.set(false);
    scroll.set(0);
    expanded.set(null);
  };
  const togglePause = () => (frozen.get() ? goLive() : pause());

  const onWheel = (e) => {
    pause(); /* examining history — stop the tail from yanking it away */
    scrollAt.set(Date.now()); /* wake the overlay scrollbar (fades when idle) */
    const d = e.deltaY > 0 ? 3 : -3;
    /* the last page aligns the oldest message to the bottom, so you can't
     * scroll past the content (and can't scroll at all when it all fits). */
    const maxScroll = Math.max(0, currentMsgs().length - viewH());
    scroll.set(Math.max(0, Math.min(maxScroll, scroll.get() + d)));
  };

  const toggle = (seq) => {
    pause(); /* freeze so the expanded payload stays put long enough to read */
    expanded.set(expanded.get() === seq ? null : seq);
  };

  /* The message set the user currently sees: frozen snapshot or live tail,
   * narrowed by the free-text query. Drives both the list and copy/export, so
   * "filter then copy" exports exactly the matching subset. */
  const currentMsgs = () => {
    const base = frozen.get() ? snap.get() : liveList();
    const m = matcher.get();
    return m.terms.length ? base.filter(m.test) : base;
  };
  const copyAll = () => {
    const m = currentMsgs();
    if (!m.length) return flash("no messages to copy");
    copy(toJsonl(m), `copied ${m.length} messages as JSONL → clipboard`);
  };
  const copyOne = (seq) => {
    /* search the unfiltered set, so "copy msg" still works if a query typed
     * after expanding would have hidden this message. */
    const base = frozen.get() ? snap.get() : liveList();
    const rec = base.find((r) => r.seq === seq);
    if (rec) copy(messageJson(rec), `copied message #${seq} → clipboard`);
  };

  /* One message's preview line — a height-1 clickable row. It is emitted as a
   * DIRECT child of the list (never wrapped in a fit-height column): a clickable
   * box only hit-tests correctly with a definite height AND a definite-height
   * parent, so the expanded payload is a sibling row, not a nested child. */
  const previewRow = (rec) => (
    <Box
      direction="row"
      height={1}
      break="none"
      bg={hoverBg(`msg:${rec.seq}`)}
      onClick={(e) => {
        toggle(rec.seq);
        e.stopPropagation();
      }}
      {...hoverTip(`msg:${rec.seq}`, () => {
        const badge = rec.inflateError
          ? " · ⚠ permessage-deflate inflate failed"
          : rec.compressed
            ? " · ⚙ arrived compressed (shown decoded)"
            : "";
        return `message #${rec.seq} · ${rec.name}, ${fmtBytes(rec.len)}${badge}; click to ${expanded.get() === rec.seq ? "collapse" : "expand"}`;
      })}
    >
      <Text break="none">
        {() => [
          fg(COL.header)(ageOf(now.get(), rec.at)),
          " ",
          arrow(rec.dir),
          " ",
          fg(roleColor(rec.dir === DIR_WRITE ? "client" : "server"))(rec.name.padEnd(5)),
          " ",
          fg(COL.dim)(fmtBytes(rec.len).padStart(6)),
          " ",
          badges(rec),
          " ",
          preview(rec),
        ]}
      </Text>
    </Box>
  );

  /* Frame-health line above an expanded payload: size + per-message compression,
   * fragmentation, masking correctness, and any close code/reason — each its own
   * hoverable indicator (a row of Tags), so every glyph explains itself. */
  const healthLine = (rec) => {
    const out = [
      Tag(
        `frame · opcode "${rec.name}", ${fmtBytes(rec.len)} decoded`,
        fg(COL.dim)(`${rec.name} · ${fmtBytes(rec.len)}`),
      ),
    ];
    if (rec.compressed && rec.wireLen > 0) {
      const ratio = rec.len / rec.wireLen;
      out.push(
        Tag(
          `⚙ permessage-deflate · this frame arrived compressed; ${fmtBytes(rec.wireLen)} on the wire inflated to ${fmtBytes(rec.len)} (${ratio.toFixed(1)}×)`,
          fg(COL.in)(` ⚙ wire ${fmtBytes(rec.wireLen)} · ${ratio.toFixed(1)}×`),
        ),
      );
    }
    if (rec.frames > 1)
      out.push(
        Tag(
          `fragmentation · this message was reassembled from ${rec.frames} WebSocket frames`,
          fg(COL.dim)(` · ${rec.frames} frames`),
        ),
      );
    /* Masking is only worth surfacing when it's WRONG — correct masking is the
     * silent default, a ✗ is the signal. RFC-6455: client→server frames must be
     * masked, server→client must not be. */
    const maskOk = rec.dir === DIR_WRITE ? rec.masked : !rec.masked;
    if (!maskOk)
      out.push(
        Tag(
          "mask ✗ · RFC-6455 masking is wrong for this direction; client→server frames must be masked and server→client must not be, so a violation here means a broken/misbehaving peer",
          fg(COL.warn)(" · mask ✗"),
        ),
      );
    if (rec.closeCode != null)
      out.push(
        Tag(
          `close · this is a CLOSE frame; code ${rec.closeCode}${rec.closeReason ? `, reason "${rec.closeReason}"` : ""}`,
          fg(COL.warn)(` · close ${rec.closeCode}${rec.closeReason ? ` "${rec.closeReason}"` : ""}`),
        ),
      );
    return out;
  };

  /* One JSON line → highlighted spans (or a literal space for a blank line). */
  const jsonLine = (l) => (l === "" ? " " : jsonTokens(l).map((t) => fg(jsonColor(t.kind))(t.text)));

  /* The expanded payload. `raw` forces a hex view even when the message decoded;
   * otherwise JSON is syntax-highlighted, text shown plain, binary/undecodable
   * as hex. */
  const Payload = (rec) => {
    const showRaw = raw.get();
    let kind, warn = null, lines;
    const json = rec.text != null ? parseJson(rec.text) : undefined; // on demand
    if (rec.inflateError) {
      warn = `⚠ inflate failed: ${rec.inflateError} · raw deflate bytes`;
      lines = hexDump(rec.bytes).split("\n");
      kind = "hex";
    } else if (showRaw) {
      // raw bytes are retained only for binary; re-encode text on demand
      lines = hexDump(rec.bytes ?? (rec.text != null ? utf8Bytes(rec.text) : null)).split("\n");
      kind = "hex";
    } else if (json !== undefined) {
      lines = JSON.stringify(json, null, 2).split("\n");
      kind = "json";
    } else if (rec.text != null) {
      lines = rec.text.split("\n");
      kind = "text";
    } else if (rec.bytes) {
      lines = hexDump(rec.bytes).split("\n");
      kind = "hex";
    } else {
      lines = [rec.control ? `(${rec.name} frame, no payload)` : "(no payload)"];
      kind = "text";
    }
    const shown = lines.slice(0, MAX_LINES);
    return (
      <Box direction="column" height="fit" padding={[0, 0, 1, 3]}>
        <Box direction="row" height={1} break="none">{healthLine(rec)}</Box>
        {warn ? <Text break="anywhere">{fg(COL.warn)(warn)}</Text> : null}
        {shown.map((l) =>
          kind === "json" ? (
            <Text break="anywhere">{jsonLine(l)}</Text>
          ) : (
            <Text break="anywhere">{fg(kind === "hex" ? COL.dim : COL.ink)(l === "" ? " " : l)}</Text>
          ),
        )}
        {lines.length > MAX_LINES ? (
          <Text break="none">{pipe(`… ${lines.length - MAX_LINES} more lines`, fg(COL.header), italic)}</Text>
        ) : null}
      </Box>
    );
  };

  return (
    <Layer>
      {/* the panel fills the body area (under the toolbar, above the minibuffer):
          a full-screen view, not a drawer — the wide JSON payloads want the room,
          and a "‹ back" button (plus Esc) returns to the connection list. */}
      <Box
        left={0}
        right={0}
        top={0}
        bottom={0}
        z={1}
        bg={COL.panel}
        padding={[0, 1]}
        direction="column"
        overflow="hidden"
      >
        {/* title row */}
        <Box direction="row" height={1} break="none">
          <Button {...tip("back to the connection list (Esc)")} onClick={closeInspector}>
            ‹ back
          </Button>
          <Text break="none">{" "}</Text>
          <Text break="none">
            {() => {
              const c = lookup();
              if (!c) return pipe("connection closed", fg(COL.warn), bold);
              return [
                pipe("inspect ", fg(COL.accent), bold),
                fg(COL.dim)(`#${c.conn} `),
                fg(roleColor(c.role))(`[${c.role}]`),
              ];
            }}
          </Text>
          <Box width="1fr" height={1} />
          <Button
            {...tip(() =>
              isFocused(selected.get())
                ? "⊙ focused · capture pinned to this connection in the kernel; click to release all connections"
                : "⊙ focus eBPF capture on just this connection · every other one goes silent in the kernel (near-zero overhead). A live user→kernel write."
            )}
            onClick={() => {
              const k = selected.get();
              isFocused(k) ? clearFocus() : setFocus(k);
            }}
            selected={() => isFocused(selected.get())}
          >
            {() => (isFocused(selected.get()) ? "⊙ focused" : "⊙ focus")}
          </Button>
          <Button
            {...tip(() =>
              frozen.get()
                ? "❚❚ paused · reading history; click to resume following newest first"
                : "● live · following newest first; click to pause (scrolling or expanding also pauses)"
            )}
            onClick={togglePause}
            selected={() => frozen.get()}
          >
            {() => (frozen.get() ? "❚❚ paused" : "● live")}
          </Button>
        </Box>

        {/* detail lines — two compact always-on lines plus an expandable block
            ("details") that surfaces every negotiated/lifecycle dimension. */}
        <Box direction="column" height="fit" break="none">
          {() => {
            const c = lookup();
            if (!c) return <Text break="anywhere">{fg(COL.dim)("It is no longer in the registry.")}</Text>;
            const n = now.get();
            const more = details.get();
            /* status is the lifecycle (open/closed); truncation is orthogonal —
             * a capture artifact, not a state — so it rides alongside as a calm
             * ✂ caution rather than clobbering the status with a red warning. */
            const STATUS = {
              open: [fg(COL.ok), "● open"],
              closed: [fg(COL.warn), "✕ closed"],
            };
            const [stat, statLabel] = STATUS[c.status] ?? STATUS.open;
            const ratio = c.wireBytes > 0 ? c.inflatedBytes / c.wireBytes : 0;
            const lines = [
              /* line 1: lifecycle + role + destination, each self-explaining */
              <Box direction="row" height={1} break="none">
                {Tag(
                  "status · the connection's lifecycle · ● open while the socket is live, ✕ closed once it has ended",
                  fg(COL.dim)("status "),
                  stat(statLabel),
                )}
                {c.truncated
                  ? Tag(
                      "✂ truncated · a capture hit the 4 KB per-SSL-call cap, so some payloads are cut off; the live stream itself is unaffected",
                      fg(COL.snip)(" · ✂ truncated"),
                    )
                  : null}
                {Tag(
                  `role · ${c.role}, inferred from the handshake direction (client = we dialed out, server = inbound)`,
                  fg(COL.dim)(" · "),
                  fg(roleColor(c.role))(c.role),
                )}
                <Box direction="row" width="1fr" height={1} break="none" {...tip(() => destTip(c))}>
                  <Text break="none" overflow="ellipsis">{[fg(COL.dim)(" · "), fg(COL.dim)(destOf(c))]}</Text>
                </Box>
              </Box>,
              /* line 2: age + message counts + byte totals + compression ratio */
              <Box direction="row" height={1} break="none">
                {Tag(
                  "how long ago this connection's handshake completed",
                  fg(COL.dim)(`opened ${fmtAgo(n - c.startedAt)}`),
                )}
                <Pair
                  desc="messages"
                  lead={pipe(" · ", fg(COL.dim))}
                  sep={pipe(" ", fg(COL.dim))}
                  up={{ color: COL.out, label: "sent (↑)", text: () => `${c.msgUp}↑` }}
                  down={{ color: COL.in, label: "received (↓)", text: () => `${c.msgDn}↓` }}
                />
                <Pair
                  desc="bytes decoded (after permessage-deflate inflate)"
                  lead={pipe(" · ", fg(COL.dim))}
                  sep={pipe(" / ", fg(COL.dim))}
                  up={{ color: COL.out, label: "sent (↑)", text: () => fmtBytes(c.hist.totalUp) }}
                  down={{ color: COL.in, label: "received (↓)", text: () => fmtBytes(c.hist.totalDown) }}
                />
                {ratio
                  ? Tag(
                      "⚙ permessage-deflate compression ratio · decoded bytes ÷ on-wire bytes, averaged over the connection",
                      fg(COL.in)(` · ⚙ ${ratio.toFixed(1)}×`),
                    )
                  : null}
              </Box>,
            ];
            if (more) {
              const row = (k, v) => (
                <Text break="anywhere">{[fg(COL.header)(k.padEnd(9)), fg(COL.dim)(v || "·")]}</Text>
              );
              const ops = Object.entries(c.opcodes)
                .map(([k, v]) => `${k} ${v}`)
                .join(" · ");
              lines.push(
                row(
                  "deflate",
                  c.deflate
                    ? `permessage-deflate · window ${c.deflate.windowBits}b${c.deflate.noContextTakeover ? " · no-takeover" : ""}`
                    : "none",
                ),
                row("subproto", c.subprotocol),
                row("ext", c.extensions),
                row("origin", c.origin),
                row("agent", c.headers["user-agent"]),
                row("opcodes", ops),
              );
              /* The process's socket endpoints (best-effort, from the kernel) —
               * the only way to learn where a handshake-less connection points,
               * though not which stream maps to which (see probes/peers.js). */
              const eps = peerInfo.get()[c.pid]?.endpoints ?? [];
              if (eps.length) lines.push(row("peers", eps.join(" · ")));
              if (c.closeCode != null)
                lines.push(row("close", `${c.closeCode}${c.closeReason ? ` "${c.closeReason}"` : ""}`));
            }
            return lines;
          }}
        </Box>

        {/* actions: capture-out (test fixtures) + discoverability toggles */}
        <Box direction="row" height={1} gap={1}>
          <Button
            {...tip("copy all shown messages as JSON Lines → clipboard (drop straight into a test fixture)")}
            onClick={copyAll}
          >
            ⧉ copy all
          </Button>
          {() =>
            expanded.get() != null ? (
              <Button {...tip("copy this message as JSON → clipboard")} onClick={() => copyOne(expanded.get())}>
                ⧉ copy msg
              </Button>
            ) : null
          }
          {() =>
            expanded.get() != null ? (
              <Button
                {...tip(() =>
                  raw.get()
                    ? "⌗ showing raw bytes (hex) · click for the decoded view"
                    : "⌗ showing the decoded view · click for raw bytes (hex)"
                )}
                onClick={toggleRaw}
                selected={() => raw.get()}
              >
                {() => (raw.get() ? "⌗ raw" : "⌗ decoded")}
              </Button>
            ) : null
          }
          <Box width="1fr" height={1} />
          <Button
            {...tip(() =>
              details.get()
                ? "⊖ hide the full connection metadata"
                : "⊕ show the full connection metadata (subprotocol, extensions, origin, opcode histogram, close)"
            )}
            onClick={toggleDetails}
            selected={() => details.get()}
          >
            {() => (details.get() ? "⊖ details" : "⊕ details")}
          </Button>
        </Box>

        <Text break="none">{fg(COL.header)(RULE)}</Text>

        {/* the message log with two overlay scroll affordances: (1) edge fades —
            a 3-row opacity gradient fading into the panel at the top edge when
            there's newer content above and the bottom edge when there's older
            below, so scrollable-ness is obvious; (2) a translucent rgba scrollbar
            thumb on the right edge for position. Both are z-stacked Layer children
            composited over the full-width log, so nothing reflows. */}
        <Box height="1fr" overflow="hidden" onWheel={onWheel}>
          <Layer height="1fr">
            <Box width="1fr" height="1fr" overflow="hidden">
              {() => {
                const c = lookup();
                if (!c) return <Text break="none">{fg(COL.dim)("  ·")}</Text>;
                now.get(); /* refresh the tail each heartbeat while following live */
                raw.get(); /* re-render the expanded payload when raw/decoded flips */
                const all = currentMsgs(); /* frozen/live tail, narrowed by the query */
                count = all.length;
                if (count === 0) {
                  const msg = search.get()
                    ? `  no messages match “${search.get()}”`
                    : c.status === "closed"
                      ? "  connection closed · no messages were captured"
                      : "  waiting for messages…";
                  return <Text break="none">{pipe(msg, fg(COL.header), italic)}</Text>;
                }
                const top = Math.min(Math.max(0, scroll.get()), Math.max(0, count - viewH()));
                const open = expanded.get();
                /* Flat list: preview rows are direct children; an expanded payload
                   follows its row as a sibling (not nested) so each clickable row
                   keeps a definite-height parent. Render a few extra rows past the
                   logical page so the list always reaches the Layer's bottom edge
                   (overflow:hidden clips them) and the bottom fade sits on text. */
                return all.slice(top, top + viewH() + OVERFILL).flatMap((rec) =>
                  rec.seq === open ? [previewRow(rec), Payload(rec)] : [previewRow(rec)],
                );
              }}
            </Box>
            {() => {
              /* Edge fades mark hidden content: top when scrolled off the newest
                 (more above), bottom when there's older scrollback (more below).
                 Absent when it all fits, so they double as a "scrollable" hint. */
              if (!lookup()) return null;
              now.get();
              const n = currentMsgs().length;
              const h = viewH();
              const top = Math.min(Math.max(0, scroll.get()), Math.max(0, n - h));
              return [
                top > 0 ? <EdgeFade edge="top" /> : null,
                top + h < n ? <EdgeFade edge="bottom" /> : null,
              ];
            }}
            {() => {
              /* Overlay scrollbar: a translucent rgba thumb on the right edge for
                 position + proportion. Built as three stacked boxes whose `fr`
                 weights (before / thumb / after, summing to a constant) flex to
                 the Layer's real height — no viewH guess. rgba bg so the rightmost
                 text column shows through, not occluded. The edge fades carry the
                 "scrollable" cue; this adds where-am-I. Hidden when it all fits. */
              if (!lookup()) return null;
              /* Web-overlay behaviour: the thumb appears on a scroll gesture and
                 fades once the pointer rests. now.get() (the heartbeat) re-runs
                 this so it hides on its own after the window elapses. */
              if (Date.now() - scrollAt.get() > SCROLLBAR_FADE_MS) return null;
              now.get();
              const n = currentMsgs().length;
              const h = viewH();
              if (n <= h) return null;
              const top = Math.min(Math.max(0, scroll.get()), Math.max(0, n - h));
              const SCALE = 1000;
              const thumbFr = Math.max(40, Math.round((h / n) * SCALE));
              const beforeFr = Math.round((top / (n - h)) * (SCALE - thumbFr));
              const afterFr = SCALE - thumbFr - beforeFr;
              const seg = (fr, col) => (fr > 0 ? <Box height={`${fr}fr`} bg={col} /> : null);
              return (
                <Box right={0} top={0} bottom={0} width={1} z={2} direction="column">
                  {seg(beforeFr, COL.scrollTrack)}
                  {seg(thumbFr, COL.scrollThumb)}
                  {seg(afterFr, COL.scrollTrack)}
                </Box>
              );
            }}
          </Layer>
        </Box>

        {/* footer hint */}
        <Text break="none">
          {() =>
            pipe(
              frozen.get()
                ? `paused · ${count} msgs · scroll for older · click ● live to resume · Esc to close`
                : `live · ${count} msgs · click a message to pause & expand · Esc to close`,
              fg(COL.header),
              italic,
            )
          }
        </Text>
      </Box>
    </Layer>
  );
}
