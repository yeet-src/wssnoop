/* fmt — value → short human string. Pure, dependency-free display formatters.
 * Kit-generic (no wssnoop domain): an extraction candidate for a shared yeet
 * formatting module. */

/* 1234 -> "1.2K", 12_345 -> "12.0K", 1_200_000 -> "1.1M" (1024-based). */
export function fmtBytes(n) {
  if (!(n > 0)) return "0B";
  const u = ["B", "K", "M", "G", "T"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return (i === 0 ? Math.round(n) : n.toFixed(1)) + u[i];
}

/* elapsed ms -> "now" / "3s" / "2m" / "1h". */
export function fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
