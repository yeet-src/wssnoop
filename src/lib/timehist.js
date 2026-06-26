/* timehist — a time-bucketed two-series ring: egress (up) and ingress (down)
 * byte counts laid out in fixed wall-clock buckets that advance as real time
 * passes. The time-keyed analogue of the retired lib/buffer.js: where that ring
 * was indexed by *push count* (an absolute monotone integer), this one is
 * indexed by *wall-clock bucket* — `floor(now / bucketMs)`. As time moves on,
 * the bucket index moves with it and old buckets fall out of the live window;
 * we don't scrub them eagerly, we just lazily treat any bucket older than the
 * ring span as zero, overwriting it the moment its slot is reused.
 *
 * Denotationally a TimeHist *is* two functions of absolute time, t → bytes, one
 * per direction, sampled into `bucketMs` cells and kept for the last `buckets`
 * cells. `add(now,dir,bytes)` integrates a chunk into the cell covering `now`;
 * `window(now,spanMs,cols)` resamples the last `spanMs` of that function into
 * `cols` equal columns (oldest → newest, left → right) for a sparkline.
 *
 *   const h = createTimeHist({ bucketMs: 2000, buckets: 900 });  // 30min @ 2s
 *   h.add(Date.now(), UP, 1280);
 *   const { up, down, peak } = h.window(Date.now(), 60_000, 40);
 *
 * Pure data — no signals, no I/O. One ring of length `buckets`, slot
 * `bucketIndex % buckets`, stamped with the bucketIndex it currently holds so a
 * stale slot reads as zero instead of as ancient bytes. */

export const DOWN = 0; /* ingress (SSL_read)  */
export const UP = 1; /* egress  (SSL_write) */

export function createTimeHist({ bucketMs = 2000, buckets = 900 } = {}) { // 30min @ 2s
  const n = Math.max(1, Math.floor(buckets));
  const dt = Math.max(1, Math.floor(bucketMs));

  /* Parallel rings. `stamp[i]` is the bucketIndex slot `i` currently holds; if
   * it doesn't match the bucketIndex we're asked about, the slot is stale (its
   * bytes belong to an aged-out bucket) and reads as zero. */
  const up = new Float64Array(n);
  const down = new Float64Array(n);
  const stamp = new Int32Array(n).fill(-1);

  let lastActive = 0;
  let totalUp = 0;
  let totalDown = 0;

  /* The (live) byte count of one direction's ring at absolute bucketIndex `b`,
   * accounting for staleness. */
  const at = (ring, b) => {
    const i = ((b % n) + n) % n;
    return stamp[i] === b ? ring[i] : 0;
  };

  /* Make slot for bucketIndex `b` current, zeroing it first if it held an older
   * bucket. Returns the slot index. */
  const slotFor = (b) => {
    const i = ((b % n) + n) % n;
    if (stamp[i] !== b) {
      stamp[i] = b;
      up[i] = 0;
      down[i] = 0;
    }
    return i;
  };

  function add(now, dir, bytes) {
    if (!(bytes > 0)) return;
    const b = Math.floor(now / dt);
    const i = slotFor(b);
    if (dir === UP) {
      up[i] += bytes;
      totalUp += bytes;
    } else {
      down[i] += bytes;
      totalDown += bytes;
    }
    if (now > lastActive) lastActive = now;
  }

  /* Resample the last `spanMs` ending at `now` into `cols` equal columns. Each
   * column covers an equal slice of [now-spanMs, now]; we sum every source
   * bucket whose center falls in the column (sub-bucket cols just re-read the
   * same bucket — coarse but honest). Column 0 is oldest, cols-1 newest. */
  function window(now, spanMs, cols) {
    const c = Math.max(1, Math.floor(cols));
    const span = Math.max(1, Math.floor(spanMs));
    const start = now - span;
    const colMs = span / c;

    const outUp = new Array(c).fill(0);
    const outDown = new Array(c).fill(0);
    let peak = 1;

    /* Walk the source buckets overlapping the window, bin each into its column
     * by bucket center. One pass over at most min(n, span/dt + 2) buckets. */
    const bFirst = Math.floor(start / dt);
    const bLast = Math.floor(now / dt);
    for (let b = bFirst; b <= bLast; b++) {
      const u = at(up, b);
      const d = at(down, b);
      if (u === 0 && d === 0) continue;
      const center = b * dt + dt / 2;
      let col = Math.floor((center - start) / colMs);
      if (col < 0) col = 0;
      else if (col >= c) col = c - 1;
      outUp[col] += u;
      outDown[col] += d;
    }
    for (let col = 0; col < c; col++) {
      if (outUp[col] > peak) peak = outUp[col];
      if (outDown[col] > peak) peak = outDown[col];
    }
    return { up: outUp, down: outDown, peak };
  }

  return {
    add,
    window,
    get lastActive() {
      return lastActive;
    },
    get totalUp() {
      return totalUp;
    },
    get totalDown() {
      return totalDown;
    },
  };
}

/* Standalone shape check — no BPF, no signals. Builds one hist, adds a ramp of
 * egress and a counter-phase ingress, and dumps a coarse window so the two
 * series and the left→right time order are eyeballable. */
if (import.meta.main) {
  const now = 1_700_000_000_000; // fixed t for reproducibility
  const h = createTimeHist({ bucketMs: 1000, buckets: 300 });
  for (let s = 0; s < 60; s++) {
    const t = now - (59 - s) * 1000;
    h.add(t, UP, s * 100); // egress ramps up over the minute
    h.add(t, DOWN, (59 - s) * 60); // ingress ramps down
  }
  const w = h.window(now, 60_000, 40);
  console.log(
    JSON.stringify(
      { lastActive: h.lastActive, totalUp: h.totalUp, totalDown: h.totalDown, ...w },
      null,
      2,
    ),
  );
}
