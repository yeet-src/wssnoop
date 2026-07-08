/* json — safe parse + a line tokenizer for syntax highlighting. Pure,
 * dependency-free. Kit-generic: an extraction candidate for a shared yeet
 * module. */

/* Parse a string as JSON, or undefined if it isn't. */
export function parseJson(text) {
  if (text == null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* Tokenize one line of (pretty-printed) JSON into typed spans a UI can color:
 * `key` (a "..." immediately before a colon), `str`, `num`, `lit`
 * (true/false/null), `punct`, and `ws`. Returns {text, kind}[]; the caller maps
 * kind → face. Line-based so it composes with line-per-row rendering. */
export function jsonTokens(line) {
  const out = [];
  const push = (text, kind) => text && out.push({ text, kind });
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
      push(line.slice(i, j), "ws");
      i = j;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === '"') { j++; break; }
        j++;
      }
      let k = j;
      while (line[k] === " ") k++;
      push(line.slice(i, j), line[k] === ":" ? "key" : "str");
      i = j;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      while (j < line.length && /[-\d.eE+]/.test(line[j])) j++;
      push(line.slice(i, j), "num");
      i = j;
    } else if (line.startsWith("true", i) || line.startsWith("false", i) || line.startsWith("null", i)) {
      const lit = line.startsWith("true", i) ? "true" : line.startsWith("false", i) ? "false" : "null";
      push(lit, "lit");
      i += lit.length;
    } else if ("{}[]:,".includes(ch)) {
      let j = i;
      while (j < line.length && "{}[]:,".includes(line[j])) j++;
      push(line.slice(i, j), "punct");
      i = j;
    } else {
      push(ch, "text");
      i++;
    }
  }
  return out;
}
