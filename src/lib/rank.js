/* rank — the wssnoop table's ordering *metrics*: how much a connection or group
 * "weighs" under each sort key, one pure place so the group order (root) and the
 * connection order within a group (group.jsx) agree. The generic ranking itself
 * — items → rank map, descending by metric — is `rankMap` (kit/rankmap.js); this
 * file supplies the domain metrics it ranks by.
 *
 * A clock tick under the "recent" key re-ranks and just re-flows the layout
 * order; ranks are small ints, which the `order` prop needs (a raw
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
