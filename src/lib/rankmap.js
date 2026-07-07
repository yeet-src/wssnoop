/* rankmap — order a set as a rank map (id → 0-based index, biggest metric
 * first) rather than a re-sorted array. Pure, dependency-free. Kit-generic: an
 * extraction candidate for a shared yeet module.
 *
 * A rank map lets a UI keep elements in stable identity order and feed each
 * node's rank into a reactive `order` prop, so a re-rank just re-flows the
 * layout order — it never rebuilds the element structure. */

/* items → Map(id → rank), descending by metric. Stable: ties keep input order
 * (Array.prototype.sort is stable), so equal-metric items don't jitter. */
export const rankMap = (items, idOf, metricOf) => {
  const sorted = [...items].sort((a, b) => metricOf(b) - metricOf(a));
  const m = new Map();
  sorted.forEach((x, i) => m.set(idOf(x), i));
  return m;
};
