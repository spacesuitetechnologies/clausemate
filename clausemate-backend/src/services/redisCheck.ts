import { createClient } from "redis";
import { config } from "../config";
import { logger } from "./logger";

/**
 * Validates that Redis has AOF persistence enabled.
 *
 * ── Why this matters ────────────────────────────────────────────────────────
 *
 * BullMQ stores all job state in Redis. Without AOF (Append-Only File)
 * persistence, a Redis restart drops every queued and in-flight job:
 *
 *   - Users who submitted contracts get no results — the jobs no longer exist.
 *   - credit_reservations rows stay stuck in "reserved" state until the
 *     stale-reservation sweeper runs (default: hourly). Until then, users
 *     see an artificially reduced credit balance.
 *
 * The stale-reservation sweeper recovers credits, but it cannot recover lost
 * jobs. AOF persistence is the only defence against job loss.
 *
 * ── Behaviour ────────────────────────────────────────────────────────────────
 *
 * - If appendonly = yes  → logs INFO and returns.
 * - If appendonly = no   → logs CRITICAL error. Does NOT crash the process
 *   (persistence being disabled is a config problem, not a code bug). The
 *   log line is the ops alert.
 * - If CONFIG GET is blocked (some managed providers disable it)  → logs WARN
 *   and skips the check. Verify persistence manually in that case.
 * - If Redis is unreachable → logs WARN and skips. The worker will fail loudly
 *   on its own; we should not double-fault at startup.
 *
 * Called once at startup, before the HTTP server begins accepting traffic.
 */
export async function checkRedisAof(): Promise<void> {
  const safeUrl = sanitizeRedisUrl(config.redis.url);
  const client = createClient({ url: config.redis.url });

  // Swallow connection-level errors — handled in the try/catch below.
  client.on("error", () => {});

  try {
    await client.connect();

    let appendonly: string | null = null;
    try {
      // configGet returns a Record<string, string>, e.g. { appendonly: "yes" }.
      const result = await client.configGet("appendonly");
      appendonly = result.appendonly ?? null;
    } catch (cmdErr: unknown) {
      // Some managed Redis providers (Upstash, Render Redis) disable CONFIG GET.
      // We cannot verify persistence — emit a warning and let the operator confirm.
      const reason = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
      logger.warn(
        {
          redisUrl: safeUrl,
          reason,
          action_required:
            "Manually verify that AOF persistence is enabled on your Redis instance " +
            "(appendonly yes, appendfsync everysec). See redis.conf in this repository.",
        },
        "redis.aof_check_skipped — CONFIG GET unavailable; cannot verify AOF persistence"
      );
      return;
    }

    if (appendonly !== "yes") {
      // ALL-CAPS prefix makes this grep-able in log aggregators (Datadog, Grafana Loki, etc.).
      logger.error(
        {
          redisUrl: safeUrl,
          appendonly: appendonly ?? "(not returned by server)",
          action_required: [
            "1. Edit redis.conf (see redis.conf in this repo) and set: appendonly yes  appendfsync everysec",
            "2. Restart Redis (CONFIG SET appendonly yes works for a running instance but does not survive restart without redis.conf).",
            "3. Without AOF, a Redis crash permanently loses all queued analysis jobs and leaves",
            "   credit_reservations stuck in 'reserved' state until the hourly sweeper runs.",
          ].join(" "),
        },
        "CRITICAL: Redis AOF persistence is DISABLED — queued jobs will be lost on Redis restart"
      );
    } else {
      logger.info(
        { redisUrl: safeUrl },
        "redis.aof_enabled — persistence check passed"
      );
    }
  } catch (err) {
    // Redis unreachable at startup — warn but do not block. The worker's own
    // connection will surface the error with more context.
    logger.warn(
      { err, redisUrl: safeUrl },
      "redis.aof_check_failed — could not connect to Redis to verify persistence"
    );
  } finally {
    try {
      await client.disconnect();
    } catch {
      // Ignore disconnect errors — the client is being discarded.
    }
  }
}

/** Strip the password from a Redis URL before writing it to logs. */
function sanitizeRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(invalid redis url)";
  }
}
