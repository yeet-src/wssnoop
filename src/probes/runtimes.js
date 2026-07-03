/* runtimes — the ONE place per-runtime knowledge lives. Each profile says how
 * to recognize a WebSocket runtime and where its TLS plaintext boundary is;
 * discover.js (attach), the browser (show/label), and the status line all read
 * from here, so supporting a new runtime is one row, not edits scattered across
 * the tap. It's deliberately fine to special-case a runtime here — that's what
 * this file is for — as long as the knowledge stays encapsulated in one table.
 *
 * `tap` names where the plaintext crosses a boundary we can hook:
 *   "exe"    static OpenSSL linked into the executable — attach the exe
 *            (node/deno/bun; also a vendored-static Rust/C++ build).
 *   "libssl" dynamic OpenSSL — attach the mapped libssl. This is detected
 *            name-agnostically by the maps scan (libsslPath below), so a profile
 *            names "libssl" only to supply a friendly label and a fallback tap.
 *   "go"     Go's crypto/tls — no OpenSSL symbols at all; needs Go-ABI uprobes
 *            on crypto/tls.(*Conn).Read/Write (register ABI + goroutine handling,
 *            the ecapture approach modernized on the yeet runtime). Not built
 *            yet, so "go" is undecodable today and degrades to opaque.
 *   "none"   no OpenSSL-family symbols on the wire path (rustls, the browser's
 *            own TLS) — undecodable by this tap by construction.
 *
 * The demo stack (5 runtimes) maps on as follows:
 *   node / python `websockets`  → recognized by name below (exe / libssl).
 *   Rust tokio-tungstenite      → native-tls is OpenSSL, so it appears via the
 *                                 maps scan (libssl) or, vendored-static, as an
 *                                 unknown-TLS candidate the exe tap attaches to;
 *                                 rustls has no OpenSSL symbols → opaque.
 *   C++ uWebSockets/uSockets    → OpenSSL, dynamic (libssl) or vendored-static
 *                                 (unknown-TLS candidate → exe tap).
 *   Go gorilla/websocket        → "go": undecodable until Go-ABI uprobes exist.
 * The unnamed ones (Rust/C++/Go binaries carry the app's own name) can't be
 * matched by name, so they're placed by the general signals — a mapped libssl,
 * or an outbound TLS port that makes them an armable candidate — and the
 * attach-and-see in state.js is the ground truth that decodes or degrades. */

const base = (p) => (p || "").split("/").pop() || "";

/* Does a process running `exe` (comm `comm`) count as runtime `name`? A bare
 * exe basename match, OR a *versioned* one — a real interpreter's exe resolves
 * to `python3.13` / `ruby3.3`, not `python3` — so `name` followed by only
 * digits/dots also matches. comm is a fallback (it can be renamed, e.g. a
 * worker that set its process title). */
export const nameMatches = (exe, comm, name) => {
  const b = base(exe);
  return b === name || (b.startsWith(name) && /^[0-9.]+$/.test(b.slice(name.length))) || comm === name;
};

const LIBSSL = /libssl/i;
/* The libssl a process maps (dynamic OpenSSL), or null. One primitive, shared by
 * resolveBin (which wants the path to attach) and classify (which wants the
 * fact). `paths` is the process's mapped file paths. */
export const libsslPath = (paths) => (paths || []).find((p) => p && LIBSSL.test(p)) ?? null;

/* Runtimes worth tracing out of the box, in the order a no-args launch prefers
 * (most likely to be a wss:// workload first). Ordered by `RUNTIMES`. */
export const RUNTIMES = [
  { id: "node", label: "node", names: ["node"], tap: "exe" },
  { id: "deno", label: "deno", names: ["deno"], tap: "exe" },
  { id: "bun", label: "bun", names: ["bun"], tap: "exe" },
  { id: "python", label: "python", names: ["python3", "python"], tap: "libssl" },
  { id: "ruby", label: "ruby", names: ["ruby"], tap: "libssl" },
];

/* The bare program names discovery matches, flattened in RUNTIMES order. */
export const KNOWN_BINS = RUNTIMES.flatMap((r) => r.names);

const decodableTap = (tap) => tap === "exe" || tap === "libssl";

/* The runtime profile a process matches by name, or null. */
export const profileFor = (exe, comm) => RUNTIMES.find((r) => r.names.some((n) => nameMatches(exe, comm, n))) ?? null;

/* Place a process on the tap landscape from graph-visible facts alone (the graph
 * exposes maps + exe, not ELF symbols), name-agnostic first so no runtime is
 * privileged. `proc` is { exe, comm, maps } (maps = mapped file paths).
 *
 *   { label, tap, decodable }
 *     decodable true  — a libssl mapping or a known static-OpenSSL runtime: the
 *                       SSL uprobe will bind.
 *     decodable false — a known non-OpenSSL runtime (go/none): shown, labeled,
 *                       but the payload stays opaque.
 *     decodable null  — unknown: no libssl, no known runtime. Could be a
 *                       static-OpenSSL C++/Rust exe (tappable) or Go/rustls
 *                       (opaque) — only arming (attach-and-see) tells them apart.
 */
export function classify({ exe, comm, maps }) {
  const profile = profileFor(exe, comm);
  if (libsslPath(maps)) return { label: profile?.label ?? "libssl", tap: "libssl", decodable: true };
  if (profile) return { label: profile.label, tap: profile.tap, decodable: decodableTap(profile.tap) };
  return { label: null, tap: "unknown", decodable: null };
}
