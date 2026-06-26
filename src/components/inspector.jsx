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
import { COL, roleColor, jsonColor } from "./palette.js";
import { fmtBytes, fmtAgo, hexDump, jsonTokens } from "../lib/format.js";
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

/* Everything a free-text query tests a message against. */
const searchable = (rec) =>
  `${rec.name} ${rec.text ?? (rec.json !== undefined ? JSON.stringify(rec.json) : "")}${rec.inflateError ?? ""}`;

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

/* Panel takes a comfortable slice for JSON, but never the whole width nor less
 * than a readable minimum; on a narrow terminal it's nearly full-screen. */
const panelW = (cols) => Math.max(40, Math.min(cols - 4, Math.round(cols * 0.62)));

const ageOf = (now, at) => `${fmtAgo(now - at)}`.padStart(4);
const arrow = (dir) => (dir === DIR_WRITE ? fg(COL.out)("↑") : fg(COL.in)("↓"));
const badges = (rec) =>
  (rec.inflateError ? fg(COL.warn)("⚠") : rec.compressed ? fg(COL.in)("⚙") : " ");

/* One message → its collapsed preview text (everything inflated already). */
function preview(rec) {
  if (rec.inflateError) return fg(COL.warn)(`inflate failed: ${rec.inflateError}`);
  let s;
  if (rec.json !== undefined) s = oneLine(JSON.stringify(rec.json));
  else if (rec.text != null) s = oneLine(rec.text);
  else if (rec.control) s = `(${rec.name})`;
  else s = `${rec.len} bytes`;
  return fg(COL.dim)(s);
}

const oneLine = (s) => (s == null ? "" : s.replace(/\s+/g, " ").trim());

export default function Inspector({ groups, now, size }) {
  let count = 0; /* messages last rendered — clamps the wheel */

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
      onClick={(e) => {
        toggle(rec.seq);
        e.stopPropagation();
      }}
      {...tip(() => `message #${rec.seq} — ${rec.name}, ${fmtBytes(rec.len)}; click to ${expanded.get() === rec.seq ? "collapse" : "expand"}`)}
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
   * fragmentation, masking correctness (client egress must be masked, server
   * ingress must not), and any close code/reason. */
  const healthLine = (rec) => {
    const out = [fg(COL.dim)(`${rec.name} · ${fmtBytes(rec.len)}`)];
    if (rec.compressed && rec.wireLen > 0) {
      const ratio = rec.len / rec.wireLen;
      out.push(fg(COL.in)(` ⚙ wire ${fmtBytes(rec.wireLen)} · ${ratio.toFixed(1)}×`));
    }
    if (rec.frames > 1) out.push(fg(COL.dim)(` · ${rec.frames} frames`));
    const maskOk = rec.dir === DIR_WRITE ? rec.masked : !rec.masked;
    out.push(maskOk ? fg(COL.dim)(" · mask ✓") : fg(COL.warn)(" · mask ✗"));
    if (rec.closeCode != null)
      out.push(fg(COL.warn)(` · close ${rec.closeCode}${rec.closeReason ? ` "${rec.closeReason}"` : ""}`));
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
    if (rec.inflateError) {
      warn = `⚠ inflate failed: ${rec.inflateError} — raw deflate bytes`;
      lines = hexDump(rec.bytes).split("\n");
      kind = "hex";
    } else if (showRaw) {
      lines = hexDump(rec.bytes).split("\n");
      kind = "hex";
    } else if (rec.json !== undefined) {
      lines = JSON.stringify(rec.json, null, 2).split("\n");
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
        <Text break="none">{healthLine(rec)}</Text>
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
        {...tip("inspector — click here or press Esc to close")}
      />

      {/* the docked panel */}
      <Box
        width={() => panelW(size.get().cols)}
        right={0}
        top={0}
        bottom={0}
        z={1}
        bg={COL.panel}
        border={{ line: "round", fg: COL.accent }}
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
            title="focus eBPF capture on just this connection — every other one goes silent in the kernel (near-zero overhead). A live user→kernel write."
            onClick={() => {
              const k = selected.get();
              isFocused(k) ? clearFocus() : setFocus(k);
            }}
            active={() => isFocused(selected.get())}
          >
            {() => (isFocused(selected.get()) ? "⊙ focused" : "⊙ focus")}
          </Button>
          <Button
            title="follow live (newest first) vs. pause to read history — scrolling or expanding pauses automatically"
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
            const STATUS = {
              open: [fg(COL.ok), "● open"],
              closed: [fg(COL.warn), "✕ closed"],
              truncated: [fg(COL.warn), "⚠ truncated"],
            };
            const [stat, statLabel] = STATUS[c.status] ?? STATUS.open;
            const ratio = c.wireBytes > 0 ? c.inflatedBytes / c.wireBytes : 0;
            const lines = [
              <Text break="anywhere">
                {[
                  fg(COL.dim)("status "),
                  stat(statLabel),
                  fg(COL.dim)(" · "),
                  fg(roleColor(c.role))(c.role),
                  fg(COL.dim)(` · ${c.dest}`),
                ]}
              </Text>,
              <Text break="none">
                {[
                  fg(COL.dim)(`opened ${fmtAgo(n - c.startedAt)} · `),
                  fg(COL.out)(`${c.msgUp}↑`),
                  fg(COL.dim)(" "),
                  fg(COL.in)(`${c.msgDn}↓`),
                  fg(COL.dim)(" · "),
                  fg(COL.out)(fmtBytes(c.hist.totalUp)),
                  fg(COL.dim)(" / "),
                  fg(COL.in)(fmtBytes(c.hist.totalDown)),
                  ratio ? fg(COL.in)(` · ⚙ ${ratio.toFixed(1)}×`) : "",
                ]}
              </Text>,
            ];
            if (more) {
              const row = (k, v) => (
                <Text break="anywhere">{[fg(COL.header)(k.padEnd(9)), fg(COL.dim)(v || "—")]}</Text>
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
                title="toggle this message between decoded and raw bytes (hex)"
                onClick={toggleRaw}
                active={() => raw.get()}
              >
                {() => (raw.get() ? "⌗ raw" : "⌗ decoded")}
              </Button>
            ) : null
          }
          <Box width="1fr" height={1} />
          <Button
            title="show / hide the full connection metadata (subprotocol, extensions, origin, opcode histogram, close)"
            onClick={toggleDetails}
            active={() => details.get()}
          >
            {() => (details.get() ? "⊖ details" : "⊕ details")}
          </Button>
        </Box>

        <Text break="none">{fg(COL.header)(RULE)}</Text>

        {/* the message log */}
        <Box height="1fr" overflow="hidden" onWheel={onWheel}>
          {() => {
            const c = lookup();
            if (!c) return <Text break="none">{fg(COL.dim)("  —")}</Text>;
            now.get(); /* refresh the tail each heartbeat while following live */
            raw.get(); /* re-render the expanded payload when raw/decoded flips */
            const all = currentMsgs(); /* frozen/live tail, narrowed by the query */
            count = all.length;
            if (count === 0) {
              const msg = search.get() ? `  no messages match “${search.get()}”` : "  waiting for messages…";
              return <Text break="none">{italic(fg(COL.header)(msg))}</Text>;
            }
            const rows = Math.max(4, size.get().rows - 15);
            const top = Math.max(0, Math.min(scroll.get(), count - 1));
            const open = expanded.get();
            /* Flat list: preview rows are direct children; an expanded payload
               follows its row as a sibling (not nested) so each clickable row
               keeps a definite-height parent. */
            return all.slice(top, top + rows).flatMap((rec) =>
              rec.seq === open ? [previewRow(rec), Payload(rec)] : [previewRow(rec)],
            );
          }}
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
