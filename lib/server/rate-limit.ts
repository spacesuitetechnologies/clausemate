/**
 * Rate limiting — uses Upstash Redis when configured, falls back to in-memory.
 *
 * Required env vars for Redis (optional):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

// ── In-memory fallback ────────────────────────────────────────────────────────

const inMemoryStore = new Map<string, number>();
const IN_MEMORY_WINDOW_MS = 5_000;

function inMemoryLimit(key: string): { allowed: boolean } {
  const now = Date.now();
  const last = inMemoryStore.get(key) ?? 0;
  if (now - last < IN_MEMORY_WINDOW_MS) return { allowed: false };
  inMemoryStore.set(key, now);
  return { allowed: true };
}

// ── Upstash Redis limiter (sliding window, 1 request per 5 s per user) ────────

let _ratelimit: {
  limit: (key: string) => Promise<{ success: boolean }>;
} | null = null;

async function getRedisLimiter() {
  if (_ratelimit) return _ratelimit;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const { Redis } = await import("@upstash/redis");
    const { Ratelimit } = await import("@upstash/ratelimit");

    const redis = new Redis({ url, token });
    _ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(1, "5 s"),
      analytics: false,
    });
    return _ratelimit;
  } catch {
    // Package not installed — fall back to in-memory
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function checkRateLimit(userId: string): Promise<{ allowed: boolean }> {
  const limiter = await getRedisLimiter();
  if (limiter) {
    const result = await limiter.limit(`analyze:${userId}`);
    return { allowed: result.success };
  }
  return inMemoryLimit(`analyze:${userId}`);
}
