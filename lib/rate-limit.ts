/**
 * In-memory sliding-window rate limiter.
 *
 * Works on Vercel serverless (per-instance, not globally shared) but still
 * catches burst abuse from a single instance. Good enough without Redis.
 */

type RateLimitResult = { allowed: boolean; retryAfterMs: number };

export function createRateLimiter(opts: {
  windowMs: number;
  maxRequests: number;
}): (key: string) => RateLimitResult {
  const { windowMs, maxRequests } = opts;
  const hits = new Map<string, number[]>();
  let lastCleanup = Date.now();

  return (key: string): RateLimitResult => {
    const now = Date.now();

    // Lazy cleanup of stale entries every 60 seconds.
    if (now - lastCleanup > 60_000) {
      const cutoff = now - windowMs;
      for (const [k, timestamps] of hits) {
        const fresh = timestamps.filter((t) => t > cutoff);
        if (fresh.length === 0) {
          hits.delete(k);
        } else {
          hits.set(k, fresh);
        }
      }
      lastCleanup = now;
    }

    const cutoff = now - windowMs;
    const timestamps = (hits.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= maxRequests) {
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow + windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    return { allowed: true, retryAfterMs: 0 };
  };
}
