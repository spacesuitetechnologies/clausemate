import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "../config";
import * as schema from "./schema";

/**
 * Single shared Postgres connection pool for the entire process.
 *
 * max: 20  — hard ceiling on simultaneous DB connections.
 *            At 20 concurrent requests every slot is used; beyond that
 *            postgres-js queues internally instead of opening new sockets.
 *            Tune via DATABASE_POOL_MAX env var if needed.
 *
 * idle_timeout: 30  — release idle connections after 30 s so we don't
 *                      hold slots unnecessarily on a quiet server.
 *
 * connect_timeout: 10 — fail fast rather than hanging a request if the
 *                        DB is temporarily unreachable.
 *
 * NOTE: Do NOT create additional postgres() instances outside this file.
 *       Import { db } everywhere else.
 */
const poolMax = parseInt(process.env.DATABASE_POOL_MAX ?? "20", 10);

const client = postgres(config.database.url, {
  max: poolMax,
  idle_timeout: 30,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });

/**
 * Exposed only for graceful shutdown — call once in the SIGTERM handler.
 * All in-flight queries finish before the pool closes.
 */
export async function closeDb(): Promise<void> {
  await client.end();
}

/**
 * Validates that database migrations have been applied before the server
 * accepts any traffic.
 *
 * Strategy: keep migrations as a separate deployment step (`npm run db:migrate`)
 * rather than auto-running them at startup. Auto-running in a multi-instance
 * environment causes DDL lock races — two pods starting simultaneously can both
 * attempt the same ALTER TABLE and deadlock each other or corrupt the journal.
 *
 * This function queries drizzle's migration journal table
 * (`__drizzle_migrations`) to verify that at least one migration has been
 * applied. If the table does not exist or is empty the process throws
 * immediately, preventing the server from serving traffic against an
 * un-migrated schema.
 *
 * Call once inside the startup IIFE in index.ts, before app.listen().
 */
export async function validateMigrations(): Promise<void> {
  try {
    const rows = await client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM __drizzle_migrations
    `;
    const count = parseInt(rows[0]?.count ?? "0", 10);
    if (count === 0) {
      throw new Error(
        "Migration journal is empty — no migrations have been applied.\n" +
        "Run: npm run db:migrate"
      );
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Postgres error 42P01 = undefined_table (table does not exist)
    if (message.includes("42P01") || message.includes("__drizzle_migrations")) {
      throw new Error(
        "Migration journal table not found — migrations have never been run.\n" +
        "Run: npm run db:migrate"
      );
    }
    // Re-throw the original error (empty journal, or DB unreachable)
    throw err;
  }
}
