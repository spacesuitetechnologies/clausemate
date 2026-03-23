import { createClient } from "redis";
import { config } from "../config";
import { logger } from "./logger";

/* ── Redis Client ─────────────────────────────────── */

let client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (!client) {
    client = createClient({ url: config.redis.url });
    client.on("error", (err) => logger.error({ err }, "blacklist.redis_error"));
    client.connect().catch((err) =>
      logger.error({ err }, "blacklist.redis_connect_failed")
    );
  }
  return client;
}

/* ── Blacklist Operations ─────────────────────────── */

/**
 * Adds a token's jti to the blacklist with a TTL equal to the
 * remaining lifetime of the token, so expired entries self-clean.
 *
 * Fails-open: if Redis is unavailable the error is logged but the
 * caller is not blocked (the old token could still be used until
 * Redis recovers, which is an acceptable availability trade-off).
 */
export async function blacklistToken(jti: string, exp: number): Promise<void> {
  const ttl = Math.max(1, exp - Math.floor(Date.now() / 1000));
  try {
    await getClient().set(`blacklist:${jti}`, "1", { EX: ttl });
  } catch (err) {
    logger.error({ jti, err }, "blacklist.set_failed");
  }
}

/**
 * Returns true if the token's jti is present in the blacklist.
 *
 * Fails-open: if Redis is unavailable, returns false so that a Redis
 * outage doesn't lock out all authenticated users. Revoked tokens
 * can be re-used during the outage window until Redis recovers.
 */
export async function isBlacklisted(jti: string): Promise<boolean> {
  try {
    const val = await getClient().get(`blacklist:${jti}`);
    return val !== null;
  } catch (err) {
    logger.error({ jti, err }, "blacklist.check_failed");
    return false;
  }
}

/* ── Graceful Shutdown ────────────────────────────── */

export async function closeBlacklistRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
  }
}
