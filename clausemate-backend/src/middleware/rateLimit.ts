import rateLimit, { type Store, type IncrementResponse } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import { config } from "../config";
import { logger } from "../services/logger";

/* ── Redis Client ─────────────────────────────────────
 *
 * A dedicated connection for rate limiting, separate from
 * BullMQ's internal ioredis connections. Shares the same
 * REDIS_URL but uses a different key prefix namespace.
 *
 * The official `redis` package auto-reconnects on failure.
 * socket.reconnectStrategy caps backoff at 3 s so a brief
 * Redis outage recovers quickly without hammering the server.
 * ────────────────────────────────────────────────────── */

const redisClient = createClient({
  url: config.redis.url,
  socket: {
    // Exponential backoff: 0 ms, 100 ms, 200 ms, … capped at 3 000 ms.
    reconnectStrategy: (retries: number) => Math.min(retries * 100, 3_000),
  },
});

redisClient.on("error", (err: Error) =>
  logger.error({ err: err.message }, "ratelimit.redis_error"),
);

redisClient.on("connect", () =>
  logger.debug("ratelimit.redis_connected"),
);

redisClient.on("reconnecting", () =>
  logger.warn("ratelimit.redis_reconnecting"),
);

// Fire-and-forget: connect in the background. The ResilientRedisStore below
// catches any errors during the window before the connection is ready.
redisClient.connect().catch((err: Error) => {
  logger.warn({ err: err.message }, "ratelimit.redis_initial_connect_failed — failing open");
});

export async function closeRateLimitRedis(): Promise<void> {
  if (redisClient.isOpen) {
    await redisClient.quit();
    logger.debug("ratelimit.redis_closed");
  }
}

/* ── Resilient Store Wrapper ──────────────────────────
 *
 * Wraps RedisStore so that a Redis outage degrades gracefully
 * instead of returning HTTP 500 to every user.
 *
 * Fail-open policy: when Redis is unavailable, return
 * { totalHits: 1 } — the request appears to be the very
 * first one in the window and is allowed through. This is
 * intentional: a Redis outage during a brute-force attack
 * is an accepted risk that must be handled at the load
 * balancer or WAF level. The alternative (blocking all
 * traffic when Redis is down) is a worse operational failure.
 *
 * Every failure is logged so ops can detect extended outages.
 * ────────────────────────────────────────────────────── */

class ResilientRedisStore implements Store {
  private inner: RedisStore;

  constructor(prefix: string) {
    this.inner = new RedisStore({
      // redis v4's sendCommand accepts string[] and returns Promise<unknown>.
      // redis v4 returns Promise<unknown>; rate-limit-redis expects a more
      // specific RedisReply type. The actual runtime value is compatible —
      // only the TS types differ. Cast through any to satisfy the constraint.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendCommand: (...args: string[]) =>
        redisClient.sendCommand(args) as Promise<any>,
      prefix,
    });
  }

  async increment(key: string): Promise<IncrementResponse> {
    try {
      return await this.inner.increment(key);
    } catch (err) {
      logger.error({ key, err: (err as Error).message }, "ratelimit.redis_increment_failed — failing open");
      // totalHits: 1 = "first request seen"; always under any configured max.
      // resetTime: undefined skips the RateLimit-Reset response header.
      return { totalHits: 1, resetTime: undefined };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.inner.decrement(key);
    } catch (err) {
      logger.error({ key, err: (err as Error).message }, "ratelimit.redis_decrement_failed");
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await this.inner.resetKey(key);
    } catch (err) {
      logger.error({ key, err: (err as Error).message }, "ratelimit.redis_resetkey_failed");
    }
  }
}

/* ── Rate Limiters ────────────────────────────────────
 *
 * Auth — strict, IP-keyed.
 *   Targets /auth/login and /auth/signup. Keyed by IP because
 *   the user is not yet authenticated. Low enough to block a
 *   credential-stuffing loop but high enough for legitimate
 *   automated scripts (CI integration tests, etc.).
 *   Default: 10 requests per 15 min (env-overridable).
 *
 * Analysis — moderate, user-keyed.
 *   Runs AFTER authMiddleware, so req.userId is always set.
 *   Keying by userId prevents shared corporate IPs (NAT,
 *   VPNs) from consuming each other's quota.
 *   Default: 10 requests per minute (env-overridable).
 *
 * General — broad, IP-keyed.
 *   Applied globally to all /api routes. Catches scrapers and
 *   unexpected traffic spikes. Not a substitute for the
 *   specific limiters above.
 * ────────────────────────────────────────────────────── */

export const authRateLimit = rateLimit({
  windowMs: config.rateLimit.auth.windowMs,
  max: config.rateLimit.auth.max,
  standardHeaders: true,
  legacyHeaders: false,
  store: new ResilientRedisStore("rl:auth:"),
  // IP-based: user not yet identified at auth endpoints.
  keyGenerator: (req) =>
    req.ip ?? req.socket.remoteAddress ?? "unknown",
  message: { error: "Too many requests, please try again later" },
});

export const analysisRateLimit = rateLimit({
  windowMs: config.rateLimit.analysis.windowMs,
  max: config.rateLimit.analysis.max,
  standardHeaders: true,
  legacyHeaders: false,
  store: new ResilientRedisStore("rl:analysis:"),
  // User-based: authMiddleware runs before this limiter, so
  // req.userId is guaranteed to be set on every request here.
  keyGenerator: (req) =>
    req.userId ?? req.ip ?? "unknown",
  message: { error: "Too many analysis requests, please try again later" },
});

export const generalRateLimit = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  store: new ResilientRedisStore("rl:general:"),
  message: { error: "Too many requests, please try again later" },
});
