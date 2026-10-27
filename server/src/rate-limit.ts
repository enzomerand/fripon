/** Counts hits per key over a sliding window, in memory (one process, reset by a restart). */
export interface RateLimiter {
  /** Records a hit when it is allowed; otherwise says how long to wait. */
  hit(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number };
}

export interface RateLimitOptions {
  /** Hits allowed per key in any `windowMs`. */
  limit: number;
  windowMs: number;
  /** Milliseconds since the epoch; injected so tests need no real waiting. */
  now: () => number;
}

export function createRateLimiter({ limit, windowMs, now }: RateLimitOptions): RateLimiter {
  // Allowed hits of each key, oldest first, never more than `limit` of them.
  const hits = new Map<string, number[]>();
  let lastSweep = now();

  /** Forgets keys whose hits are all out of the window, so the map cannot grow forever. */
  function sweep(at: number): void {
    lastSweep = at;
    for (const [key, times] of hits) {
      if ((times[times.length - 1] ?? 0) <= at - windowMs) hits.delete(key);
    }
  }

  return {
    hit(key) {
      const at = now();
      if (at - lastSweep >= windowMs) sweep(at);

      const recent = (hits.get(key) ?? []).filter((time) => time > at - windowMs);
      const oldest = recent[0];
      if (recent.length >= limit && oldest !== undefined) {
        hits.set(key, recent);
        return { allowed: false, retryAfterSeconds: Math.ceil((oldest + windowMs - at) / 1000) };
      }
      recent.push(at);
      hits.set(key, recent);
      return { allowed: true };
    },
  };
}
