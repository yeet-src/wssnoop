/* containers — the Docker container registry, as a short-id → identity map.
 * procinfo derives a 12-hex container id from a process's cgroup path (works
 * with no Docker daemon at all); this resolves that id to a human name/image
 * via the system graph's `docker` field, so the UI can group and label by
 * container. Best-effort: with no Docker daemon (or no permission) the query
 * fails and the map stays empty — callers fall back to the short id.
 *
 *   containers.get()[shortId]  // -> { name, image, state } | undefined
 *   containerName(shortId)     // -> name, or the id itself if unresolved
 */

import { from } from "yeet:tui";

import { race } from "../kit/race.js";

/* Container summaries are small, but a wedged Docker socket shouldn't stall us
 * — race every poll against a short timeout (see README's graph caveat). */
const QUERY = `{ docker { list_containers { id names image state } } }`;

export const containers = from((state) => {
  let stopped = false;
  const tick = async () => {
    try {
      const { data } = await race(yeet.graph.query(QUERY), 1500);
      const m = {};
      for (const c of data?.docker?.list_containers ?? []) {
        if (!c.id) continue;
        const short = c.id.slice(0, 12);
        m[short] = {
          name: (c.names?.[0] ?? "").replace(/^\//, "") || short, // Docker prefixes a slash
          image: c.image ?? "",
          state: c.state ?? null,
        };
      }
      if (!stopped) state.set(m);
    } catch {
      /* no Docker daemon / not permitted: leave the map as-is, ids stand in */
    }
  };
  tick();
  const h = setInterval(tick, 8000);
  return () => {
    stopped = true;
    clearInterval(h);
  };
}, {});

export const containerName = (shortId) => containers.get()[shortId]?.name ?? shortId;
