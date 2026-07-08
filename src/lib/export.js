/* wssnoop/export — serialize captured messages for copy-out. The prospect's
 * headline use case: lift real exchange message responses straight into a test
 * suite. So the export is plain, lossless-ish JSON — one record per message,
 * decoded the way the app would see it (deflate already inflated), with the
 * compression/error provenance preserved and a base64 escape hatch for bytes
 * that don't decode to text. Pure: returns strings; the clipboard write (OSC52
 * via tty) lives at the component edge. */

import { DIR_WRITE } from "./decode.js";
import { base64 } from "../kit/bytes.js";
import { parseJson } from "../kit/json.js";

/* One retained message → a test-suite-friendly record. `dir` names the flow
 * from the traced process's view; `json`/`text` carry the decoded payload, or
 * `base64` the raw bytes when it isn't text. */
export function messageRecord(rec) {
  const r = {
    seq: rec.seq,
    dir: rec.dir === DIR_WRITE ? "out" : "in",
    opcode: rec.name,
    len: rec.len,
  };
  if (rec.compressed) r.compressed = true;
  if (rec.inflateError) r.inflateError = rec.inflateError;
  if (rec.text != null) {
    const j = parseJson(rec.text);
    if (j !== undefined) r.json = j; // structured when it parses…
    else r.text = rec.text; // …raw text otherwise
  } else if (rec.bytes) {
    r.base64 = base64(rec.bytes);
  }
  return r;
}

/* A connection's messages as JSON Lines (one record per line), oldest first —
 * the natural order for a captured session. `msgs` is newest-first (the ring's
 * recent()), so reverse for chronological output. */
export function toJsonl(msgs) {
  return msgs
    .slice()
    .reverse()
    .map((rec) => JSON.stringify(messageRecord(rec)))
    .join("\n");
}

/* A single message, pretty-printed — for "copy this message". */
export function messageJson(rec) {
  return JSON.stringify(messageRecord(rec), null, 2);
}
