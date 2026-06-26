/* wssnoop/inspector — the drill-down overlay. Clicking a connection row sets
 * controls.selected to its key; root mounts this on top of the list as a Layer:
 * a translucent scrim that dims (and click-dismisses) the table behind, plus a
 * right-docked panel showing the connection's details and a live, scrollable
 * log of its decoded messages — newest first, click one to expand its payload.
 *
 * The decoder (lib/decode.js) has already inflated permessage-deflate and parsed
 * TEXT/JSON by the time state.js retains a message, so expanding a compressed
 * frame shows the *decompressed* content; the ⚙ badge marks that it arrived
 * compressed, and a ⚠ badge (with the raw bytes) marks an inflate failure.
 *
 * It reads the clock (`now`) in its own thunks, so counts and the message log
 * stay live without the caller re-rendering; it resolves `selected` against the
 * live registry each frame, so a closed/evicted connection degrades to a notice
 * rather than a stale freeze. View-state (scroll/expand/freeze) lives in
 * controls.js, not here: the root body re-projects on membership churn, which
 * re-creates this component — module-level signals survive that; `inspect`
 * resets them when a new connection is opened. */

import { Box, Text, Layer, bold, italic, fg } from "yeet:tui";

import Button from "./button.jsx";
import { hoverTip, hoverBg } from "./hover.js";
import { COL, roleColor, jsonColor } from "./palette.js";
import { fmtBytes, fmtAgo, hexDump, jsonTokens, parseJson, utf8Bytes } from "../lib/format.js";
import { toJsonl, messageJson } from "../lib/export.js";
import { DIR_WRITE } from "../lib/decode.js";
import {
  selected,
  selectedConn,
  closeInspector,
  tip,
  flash,
  search,
  matches,
  inspectScroll as scroll,
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

/* Everything a free-text query tests a message against (text is the JSON). */
const searchable = (rec) => `${rec.name} ${rec.text ?? ""}${rec.inflateError ?? ""}`;

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

/* Panel takes most of the width — JSON is wide — but never the whole screen nor
 * less than a readable minimum; on a narrow terminal it's nearly full-screen.
 * It docks flush to the right edge, so the only inset is for a little air on the
 * left where the table stays visible. */
const panelW = (cols) => Math.max(40, Math.min(cols - 4, Math.round(cols * 0.72)));

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
  <Box direction="row" height={1} break="none" {...tip(title)}>
    <Text break="none">{content}</Text>
  </Box>
);

export default function Inspector({ groups, now, size }) {
  let count = 0; /* messages last rendered — clamps the wheel */
  /* Visible message rows = the log viewport height, shared by the list and the
   * scrollbar so the thumb math matches what's shown (≈ panel minus chrome). */
  const viewH = () => Math.max(4, size.get().rows - 15);

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
    const d = e.deltaY > 0 ? 3 : -3;
    scroll.set(Math.max(0, Math.min(count - 1, scroll.get() + d)));
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
    const q = search.get();
    return q ? base.filter((r) => matches(searchable(r), q)) : base;
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
    const maskOk = rec.dir === DIR_WRITE ? rec.masked : !rec.masked;
    out.push(
      Tag(
        maskOk
          ? "mask ✓ · RFC-6455 masking is correct (client→server frames must be masked, server→client must not be)"
          : "mask ✗ · RFC-6455 masking is wrong for this direction; client→server frames must be masked and server→client must not be, so a violation here means a broken/misbehaving peer",
        maskOk ? fg(COL.dim)(" · mask ✓") : fg(COL.warn)(" · mask ✗"),
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
          <Text break="none">{italic(fg(COL.header)(`… ${lines.length - MAX_LINES} more lines`))}</Text>
        ) : null}
      </Box>
    );
  };

  return (
    <Layer>
      {/* scrim: dims the list and dismisses on click (panel sits on top, so a
          click on the panel never reaches it) */}
      <Box
        width="1fr"
        height="1fr"
        bg={COL.scrim}
        onClick={closeInspector}
        {...tip("inspector · click here or press Esc to close")}
      />

      {/* the panel — a drawer docked flush to the right edge. No surrounding
          frame: it spans the full height against the right side and carries a
          border on just its LEFT side (the seam where it meets the table), so it
          reads as protruding from the edge rather than floating over it. */}
      <Box
        width={() => panelW(size.get().cols)}
        right={0}
        top={0}
        bottom={0}
        z={1}
        bg={COL.panel}
        border={{ line: "round", sides: ["left"], fg: COL.accent }}
        padding={[0, 1]}
        direction="column"
        overflow="hidden"
      >
        {/* title row */}
        <Box direction="row" height={1} break="none">
          <Text break="none">
            {() => {
              const c = lookup();
              if (!c) return bold(fg(COL.warn)("connection closed"));
              return [
                bold(fg(COL.accent)("inspect ")),
                fg(COL.dim)(`#${c.conn} `),
                fg(roleColor(c.role))(`[${c.role}]`),
              ];
            }}
          </Text>
          <Box width="1fr" height={1} />
          <Button
            title={() =>
              isFocused(selected.get())
                ? "⊙ focused · capture pinned to this connection in the kernel; click to release all connections"
                : "⊙ focus eBPF capture on just this connection · every other one goes silent in the kernel (near-zero overhead). A live user→kernel write."
            }
            onClick={() => {
              const k = selected.get();
              isFocused(k) ? clearFocus() : setFocus(k);
            }}
            active={() => isFocused(selected.get())}
          >
            {() => (isFocused(selected.get()) ? "⊙ focused" : "⊙ focus")}
          </Button>
          <Button
            title={() =>
              frozen.get()
                ? "❚❚ paused · reading history; click to resume following newest first"
                : "● live · following newest first; click to pause (scrolling or expanding also pauses)"
            }
            onClick={togglePause}
            active={() => frozen.get()}
          >
            {() => (frozen.get() ? "❚❚ paused" : "● live")}
          </Button>
          <Button title="close the inspector (Esc)" onClick={closeInspector}>
            ✕
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
                <Box direction="row" width="1fr" height={1} break="none" {...tip("destination · the wss:// URL this connection is talking to")}>
                  <Text break="none" overflow="ellipsis">{[fg(COL.dim)(" · "), fg(COL.dim)(c.dest)]}</Text>
                </Box>
              </Box>,
              /* line 2: age + message counts + byte totals + compression ratio */
              <Box direction="row" height={1} break="none">
                {Tag(
                  "how long ago this connection's handshake completed",
                  fg(COL.dim)(`opened ${fmtAgo(n - c.startedAt)}`),
                )}
                {Tag(
                  "messages sent (↑) and received (↓) on this connection",
                  fg(COL.dim)(" · "),
                  fg(COL.out)(`${c.msgUp}↑`),
                  fg(COL.dim)(" "),
                  fg(COL.in)(`${c.msgDn}↓`),
                )}
                {Tag(
                  "total bytes sent / received, decoded (after permessage-deflate inflate)",
                  fg(COL.dim)(" · "),
                  fg(COL.out)(fmtBytes(c.hist.totalUp)),
                  fg(COL.dim)(" / "),
                  fg(COL.in)(fmtBytes(c.hist.totalDown)),
                )}
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
              if (c.closeCode != null)
                lines.push(row("close", `${c.closeCode}${c.closeReason ? ` "${c.closeReason}"` : ""}`));
            }
            return lines;
          }}
        </Box>

        {/* actions: capture-out (test fixtures) + discoverability toggles */}
        <Box direction="row" height={1} gap={1}>
          <Button
            title="copy all shown messages as JSON Lines → clipboard (drop straight into a test fixture)"
            onClick={copyAll}
          >
            ⧉ copy all
          </Button>
          {() =>
            expanded.get() != null ? (
              <Button title="copy this message as JSON → clipboard" onClick={() => copyOne(expanded.get())}>
                ⧉ copy msg
              </Button>
            ) : null
          }
          {() =>
            expanded.get() != null ? (
              <Button
                title={() =>
                  raw.get()
                    ? "⌗ showing raw bytes (hex) · click for the decoded view"
                    : "⌗ showing the decoded view · click for raw bytes (hex)"
                }
                onClick={toggleRaw}
                active={() => raw.get()}
              >
                {() => (raw.get() ? "⌗ raw" : "⌗ decoded")}
              </Button>
            ) : null
          }
          <Box width="1fr" height={1} />
          <Button
            title={() =>
              details.get()
                ? "⊖ hide the full connection metadata"
                : "⊕ show the full connection metadata (subprotocol, extensions, origin, opcode histogram, close)"
            }
            onClick={toggleDetails}
            active={() => details.get()}
          >
            {() => (details.get() ? "⊖ details" : "⊕ details")}
          </Button>
        </Box>

        <Text break="none">{fg(COL.header)(RULE)}</Text>

        {/* the message log with an OVERLAY scrollbar: the log fills the full
            width and the scrollbar floats over its right edge (a z-stacked Layer
            child) rather than reserving a column, so nothing reflows when it
            appears/disappears. */}
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
                  const msg = search.get() ? `  no messages match “${search.get()}”` : "  waiting for messages…";
                  return <Text break="none">{italic(fg(COL.header)(msg))}</Text>;
                }
                const top = Math.max(0, Math.min(scroll.get(), count - 1));
                const open = expanded.get();
                /* Flat list: preview rows are direct children; an expanded payload
                   follows its row as a sibling (not nested) so each clickable row
                   keeps a definite-height parent. */
                return all.slice(top, top + viewH()).flatMap((rec) =>
                  rec.seq === open ? [previewRow(rec), Payload(rec)] : [previewRow(rec)],
                );
              }}
            </Box>
            {() => {
              /* A proportional scrollbar floating on the right edge: thumb size =
                 window/total, position = scroll/maxScroll. Absent when it all
                 fits. Its glyphs draw over the log's last column (overlay style). */
              if (!lookup()) return null;
              now.get();
              const n = currentMsgs().length;
              const h = viewH();
              if (n <= h) return null;
              const thumb = Math.max(1, Math.round((h / n) * h));
              const top = Math.max(0, Math.min(scroll.get(), n - 1));
              const pos = Math.min(h - thumb, Math.round((top / Math.max(1, n - h)) * (h - thumb)));
              return (
                <Box right={0} top={0} width={1} z={1} direction="column" break="none">
                  {Array.from({ length: h }, (_, i) => (
                    <Text height={1} break="none">
                      {i >= pos && i < pos + thumb ? fg(COL.accent)("█") : fg(COL.header)("░")}
                    </Text>
                  ))}
                </Box>
              );
            }}
          </Layer>
        </Box>

        {/* footer hint */}
        <Text break="none">
          {() =>
            italic(
              fg(COL.header)(
                frozen.get()
                  ? `paused · ${count} msgs · scroll for older · click ● live to resume · Esc to close`
                  : `live · ${count} msgs · click a message to pause & expand · Esc to close`,
              ),
            )
          }
        </Text>
      </Box>
    </Layer>
  );
}
