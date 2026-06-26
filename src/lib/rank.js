/* rank — the ordering metrics for the grouped table, one pure place so the
 * group order (root) and the connection order within a group (group.jsx) agree.
 *
 * Sorting is expressed as a *rank map* (id → 0-based index, biggest metric
 * first), not a re-sorted array: the UI keeps elements in stable identity order
 * and feeds the rank into each node's reactive `order` prop, so a re-rank (or a
 * clock tick under the "recent" key) just re-flows the layout order — it never
 * rebuilds the row structure. Ranks are small ints, which `order` needs (a raw
 * byte/timestamp metric would overflow). */

/* Bytes through a hist within the current viz window — the "recent" key and the
 * activeOnly filter both read this. */
export const recentBytes = (hist, now, span) => {
  const w = hist.window(now, span, 1);
  return (w.up[0] || 0) + (w.down[0] || 0);
};

export const lifeBytes = (hist) => hist.totalUp + hist.totalDown;

export const connMetric = (c, key, now, span) =>
  key === "newest" ? c.startedAt : key === "bytes" ? lifeBytes(c.hist) : recentBytes(c.hist, now, span);

export const groupMetric = (g, key, now, span) =>
  key === "newest"
    ? g.conns.reduce((m, c) => Math.max(m, c.startedAt), 0)
    : key === "bytes"
      ? lifeBytes(g.hist)
      : recentBytes(g.hist, now, span);

/* items → Map(id → rank), descending by metric. Stable: ties keep input order
 * (Array.prototype.sort is stable), so equal-metric rows don't jitter. */
export const rankMap = (items, idOf, metricOf) => {
  const sorted = [...items].sort((a, b) => metricOf(b) - metricOf(a));
  const m = new Map();
  sorted.forEach((x, i) => m.set(idOf(x), i));
  return m;
};
