/**
 * Rate limiting — uses Upstash Redis when configured, falls back to in-memory.
 *
 * Presets:
 *   "analyze"           — 1 request per 5s (default)
 *   "generate-contract" — 1 request per 30s
 *   "generate-clause"   — 1 request per 3s
 *
 * Optional env vars:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

export type RateLimitPreset = "analyze" | "generate-contract" | "generate-clause";

interface Window {
  requests: number;
  windowMs: number;
}

const WINDOWS: Record<RateLimitPreset, Window> = {
  "analyze":           { requests: 1, windowMs: 5_000 },
  "generate-contract": { requests: 1, windowMs: 30_000 },
  "generate-clause":   { requests: 1, windowMs: 3_000 },
};

// ── In-memory fallback (resets on cold start) ─────────────────────────────────

const inMemoryStore = new Map<string, number>();

function inMemoryLimit(key: string, windowMs: number): { allowed: boolean } {
  const now = Date.now();
  const last = inMemoryStore.get(key) ?? 0;
  if (now - last < windowMs) return { allowed: false };
  inMemoryStore.set(key, now);
  return { allowed: true };
}

// ── Upstash Redis limiters (one per preset) ───────────────────────────────────

type RedisLimiter = { limit: (key: string) => Promise<{ success: boolean }> };

const _limiters = new Map<RateLimitPreset, RedisLimiter>();

async function getRedisLimiter(preset: RateLimitPreset): Promise<RedisLimiter | null> {
  if (_limiters.has(preset)) return _limiters.get(preset)!;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const { Redis } = await import("@upstash/redis");
    const { Ratelimit } = await import("@upstash/ratelimit");

    const redis = new Redis({ url, token });
    const { requests, windowMs } = WINDOWS[preset];
    const windowSec = Math.round(windowMs / 1000);

    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(requests, `${windowSec} s`),
      analytics: false,
    }) as RedisLimiter;

    _limiters.set(preset, limiter);
    return limiter;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function checkRateLimit(
  userId: string,
  preset: RateLimitPreset = "analyze",
): Promise<{ allowed: boolean }> {
  const key = `${preset}:${userId}`;
  const limiter = await getRedisLimiter(preset);

  if (limiter) {
    const result = await limiter.limit(key);
    return { allowed: result.success };
  }

  return inMemoryLimit(key, WINDOWS[preset].windowMs);
}
