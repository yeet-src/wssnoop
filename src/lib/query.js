/* query — the message-filter language. A query denotes a predicate over a
 * message, `Msg → Bool`, built as a conjunction (AND) of terms:
 *
 *   $.price > 100            field test  (JSON path, comparison, literal)
 *   $json.type == "trade"    explicit encoding prefix
 *   $.error                  presence    (the path resolves to something)
 *   $.tags ~ urgent          substring   (the field's text contains "urgent")
 *   btc                      plain text  (case-insensitive substring of the msg)
 *   $.price > 100 btc        both, ANDed (price over 100 AND text has "btc")
 *
 * Operators: > >= < <= (numeric) · == != (typed) · ~ (substring) · = (alias ==).
 * Paths are dotted with [n] indices: $.a.b[0].c. The encoding after `$` (default
 * `json`) selects how the message body is decoded into a value tree, so the same
 * grammar extends to other framings later — add an extractor to ENCODINGS and
 * `$cbor.x`/`$msgpack.x` work for free.
 *
 * A query with no `$` is a single plain substring (the original search), so
 * existing text search is unchanged; the term grammar only kicks in once a
 * field reference appears. Pure — no signals, no UI. */

import { parseJson } from "./format.js";

/* Encoding → (record → value tree). The body decoders the field grammar can
 * reach. Keyed by the `$<enc>` prefix; `json` is the default. */
const ENCODINGS = {
  json: (rec) => parseJson(rec?.text),
};

const OPCHARS = "<>=!~";
const isWS = (c) => c === " " || c === "\t";

/* ---- lex ------------------------------------------------------------- */

/* `$[enc](.key|[n])+` starting at i, or null if it isn't a well-formed
 * accessor (so a bare "$5" falls back to plain text). */
function readAccessor(s, i) {
  const n = s.length;
  let j = i + 1; // past '$'
  let enc = "";
  let k = j;
  while (k < n && /\w/.test(s[k])) k++;
  if (k > j && (s[k] === "." || s[k] === "[")) {
    enc = s.slice(j, k);
    j = k;
  }
  const path = [];
  while (j < n) {
    if (s[j] === ".") {
      let m = ++j;
      while (m < n && /[\w-]/.test(s[m])) m++;
      if (m === j) break;
      path.push(s.slice(j, m));
      j = m;
    } else if (s[j] === "[") {
      let m = j + 1;
      let num = "";
      while (m < n && /\d/.test(s[m])) num += s[m++];
      if (num === "" || s[m] !== "]") break;
      path.push(Number(num));
      j = m + 1;
    } else break;
  }
  return path.length ? { enc: enc || "json", path, end: j } : null;
}

function tokenize(s) {
  const toks = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (isWS(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = "";
      while (j < n && s[j] !== c) {
        if (s[j] === "\\" && j + 1 < n) { out += s[j + 1]; j += 2; }
        else out += s[j++];
      }
      toks.push({ t: "str", v: out });
      i = j + 1; // past closing quote (or EOS)
      continue;
    }
    if (c === "$") {
      const acc = readAccessor(s, i);
      if (acc) { toks.push({ t: "acc", enc: acc.enc, path: acc.path }); i = acc.end; continue; }
    }
    if (OPCHARS.includes(c)) {
      let j = i + 1;
      if (j < n && OPCHARS.includes(s[j])) j++; // two-char ops: >= <= == !=
      toks.push({ t: "op", v: s.slice(i, j) });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !isWS(s[j]) && !OPCHARS.includes(s[j]) && s[j] !== '"' && s[j] !== "'") j++;
    toks.push({ t: "word", v: s.slice(i, j) });
    i = j;
  }
  return toks;
}

/* A word literal carries its JSON type so == / numeric ops behave sensibly. */
function literal(tok) {
  if (tok.t === "str") return { type: "str", v: tok.v };
  const w = tok.v;
  if (/^-?\d+(\.\d+)?$/.test(w)) return { type: "num", v: Number(w) };
  if (w === "true" || w === "false") return { type: "bool", v: w === "true" };
  if (w === "null") return { type: "null", v: null };
  return { type: "str", v: w };
}

/* ---- parse ----------------------------------------------------------- */

function parseTerms(toks) {
  const terms = [];
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === "acc") {
      const op = toks[i + 1];
      const lit = toks[i + 2];
      if (op?.t === "op" && (lit?.t === "word" || lit?.t === "str")) {
        terms.push({ kind: "cmp", enc: tk.enc, path: tk.path, op: op.v, lit: literal(lit) });
        i += 3;
      } else {
        terms.push({ kind: "has", enc: tk.enc, path: tk.path }); // presence
        i += 1;
      }
    } else if (tk.t === "str" || tk.t === "word") {
      terms.push({ kind: "text", v: tk.v });
      i += 1;
    } else i += 1; // stray operator: ignore
  }
  return terms;
}

/* ---- evaluate -------------------------------------------------------- */

const getPath = (root, path) => {
  let v = root;
  for (const seg of path) {
    if (v == null) return undefined;
    v = v[seg];
  }
  return v;
};

const eqVal = (v, lit) => {
  if (lit.type === "num") return Number(v) === lit.v;
  if (lit.type === "bool") return v === lit.v || String(v) === String(lit.v);
  if (lit.type === "null") return v === null;
  return String(v).toLowerCase() === String(lit.v).toLowerCase();
};

/* Comparison against a resolved field value. An absent field (undefined) never
 * matches — "doesn't have it" is not "not equal to it". Numeric ops coerce and
 * lean on NaN comparisons being false, so a non-numeric field simply drops out. */
function compare(v, op, lit) {
  if (v === undefined) return false;
  switch (op) {
    case "~": return String(v).toLowerCase().includes(String(lit.v).toLowerCase());
    case "==": case "=": return eqVal(v, lit);
    case "!=": return !eqVal(v, lit);
    case ">": return Number(v) > Number(lit.v);
    case ">=": return Number(v) >= Number(lit.v);
    case "<": return Number(v) < Number(lit.v);
    case "<=": return Number(v) <= Number(lit.v);
    default: return false;
  }
}

function termPred(term, text, encodings) {
  if (term.kind === "text") {
    const needle = term.v.toLowerCase();
    return (rec) => String(text(rec) ?? "").toLowerCase().includes(needle);
  }
  const decode = encodings[term.enc] ?? encodings.json;
  if (term.kind === "has") return (rec) => getPath(decode(rec), term.path) !== undefined;
  return (rec) => compare(getPath(decode(rec), term.path), term.op, term.lit);
}

/* Compile a query into { test(rec), terms, fields }. `cfg.text` extracts the
 * plain-text haystack from a record (default `rec.text`); `cfg.encodings`
 * overrides the body decoders. An empty query matches everything. A query with
 * no `$` is one plain substring, preserving the original search semantics. */
export function compile(q, cfg = {}) {
  const text = cfg.text ?? ((rec) => rec?.text ?? "");
  const encodings = cfg.encodings ?? ENCODINGS;
  const src = q ?? "";
  const terms = src.includes("$") ? parseTerms(tokenize(src)) : src.trim() ? [{ kind: "text", v: src }] : [];
  const preds = terms.map((t) => termPred(t, text, encodings));
  const test = (rec) => preds.every((p) => p(rec));
  return { test, terms, fields: terms.some((t) => t.kind !== "text") };
}

/* Standalone shape check: a handful of records through a handful of queries. */
if (import.meta.main) {
  const recs = [
    { text: '{"type":"trade","price":150,"sym":"BTC-USD"}' },
    { text: '{"type":"quote","price":50,"sym":"ETH-USD"}' },
    { text: '{"type":"trade","price":99.5,"error":"stale"}' },
    { text: "plain hello world" },
  ];
  for (const q of ["$.price > 100", '$.type == "trade"', "$.error", "$.sym ~ usd", "hello", "$.price>=99.5 trade"]) {
    const { test } = compile(q);
    console.log(`${q.padEnd(22)} -> ${recs.map((r, i) => (test(r) ? i : "·")).join(" ")}`);
  }
}
