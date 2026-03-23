import { eq, and, lt, notExists } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { getStorage } from "./storage";
import { logger } from "./logger";
import { config } from "../config";

/**
 * Deletes abandoned contract uploads from both storage and the database.
 *
 * "Orphan" definition: a contract row whose status is still "uploaded"
 * (meaning it was never submitted for analysis, or the analysis insert
 * failed before the job was queued) AND whose createdAt is older than
 * `config.storage.orphanRetentionDays`.
 *
 * Contracts with a pending, processing, or completed analysis are never
 * touched — we only reclaim storage for files the user clearly abandoned.
 *
 * Deletion is best-effort per row: a failed file delete does not abort
 * the remaining batch, and the DB row is still removed so the orphan
 * does not resurface in subsequent cleanup runs (the file will be an
 * anonymous unreferenced blob on disk, collected on the next run once
 * the FS error is resolved).
 *
 * @returns Number of contracts cleaned up.
 */
export async function cleanupOrphanFiles(): Promise<{ cleaned: number }> {
  const retentionDays = config.storage.orphanRetentionDays;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // Select orphan contracts: status "uploaded" with no analysis rows at all,
  // created before the cutoff. The notExists sub-select is cheaper than a
  // LEFT JOIN when the analyses table is large and most contracts have rows.
  const orphans = await db
    .select({
      id: schema.contracts.id,
      storagePath: schema.contracts.storagePath,
    })
    .from(schema.contracts)
    .where(
      and(
        eq(schema.contracts.status, "uploaded"),
        lt(schema.contracts.createdAt, cutoff),
        notExists(
          db
            .select({ id: schema.analyses.id })
            .from(schema.analyses)
            .where(eq(schema.analyses.contractId, schema.contracts.id))
        )
      )
    );

  if (orphans.length === 0) {
    return { cleaned: 0 };
  }

  logger.info({ count: orphans.length, cutoff }, "cleanup.orphans_found");

  const storage = getStorage();
  let cleaned = 0;

  for (const contract of orphans) {
    // Attempt file deletion first. If the file is already missing (e.g. was
    // manually removed), that is not an error — proceed to remove the DB row.
    try {
      const fileExists = await storage.exists(contract.storagePath);
      if (fileExists) {
        await storage.delete(contract.storagePath);
      }
    } catch (err) {
      logger.warn(
        { contractId: contract.id, storagePath: contract.storagePath, err },
        "cleanup.file_delete_failed"
      );
      // Do not skip the DB row — a stuck file should not block DB cleanup.
    }

    try {
      await db
        .delete(schema.contracts)
        .where(eq(schema.contracts.id, contract.id));
      cleaned++;
    } catch (err) {
      logger.error(
        { contractId: contract.id, err },
        "cleanup.db_delete_failed"
      );
    }
  }

  logger.info({ cleaned, attempted: orphans.length }, "cleanup.completed");
  return { cleaned };
}

/**
 * Starts a daily background cleanup timer.
 *
 * Runs one pass immediately at startup (non-blocking — errors are logged
 * and swallowed), then repeats every 24 hours. Call `stopCleanupScheduler`
 * for a clean shutdown.
 */
export function startCleanupScheduler(): NodeJS.Timeout {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  const run = () => {
    cleanupOrphanFiles().catch((err) => {
      logger.error({ err }, "cleanup.scheduler_error");
    });
  };

  // Fire once on startup so orphans accumulated during a downtime are
  // collected immediately rather than waiting a full day.
  run();

  return setInterval(run, MS_PER_DAY);
}

export function stopCleanupScheduler(timer: NodeJS.Timeout): void {
  clearInterval(timer);
}
