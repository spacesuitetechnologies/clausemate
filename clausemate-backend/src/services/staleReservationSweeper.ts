import { and, eq, lt, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { releaseReservation } from "./creditSystem";
import { logger } from "./logger";
import { config } from "../config";

/**
 * Sweeps stale credit reservations and stuck analysis rows.
 *
 * ── Problem ─────────────────────────────────────────────────────────────────
 *
 * The normal credit lifecycle is:
 *
 *   reserveCredits() → BullMQ job runs → finalizeCredits()  [on success]
 *                                      → releaseReservation() [on final failure]
 *
 * If Redis is restarted WITHOUT AOF persistence, the BullMQ job entry
 * disappears. The worker never runs finalizeCredits() or releaseReservation(),
 * so credit_reservations rows stay in "reserved" state indefinitely. The user's
 * available balance is permanently reduced by the reserved amount.
 *
 * BullMQ stall detection also cannot fire — the job no longer exists in Redis,
 * so there is nothing for the stalled-job scanner to find.
 *
 * ── Solution ─────────────────────────────────────────────────────────────────
 *
 * This sweeper runs periodically (default: every hour) and:
 *
 *   1. Finds credit_reservations that have been in "reserved" state longer than
 *      the configured cutoff (default: 2 hours = jobTimeout × maxAttempts × 2).
 *      Calls releaseReservation() for each — this is safe because
 *      releaseReservation() uses a conditional UPDATE WHERE status = 'reserved',
 *      so it is a no-op if the reservation was already resolved.
 *
 *   2. Finds analyses stuck in "processing" state (startedAt < cutoff) and
 *      marks them "failed" with an operator-readable error message.
 *      These correspond to jobs that the worker picked up but never completed.
 *
 * ── What the sweeper does NOT cover ──────────────────────────────────────────
 *
 * Analyses stuck in "queued" state cannot be aged by this sweeper because
 * the analyses table has no creation timestamp — only startedAt (set when
 * the worker picks up the job, not when the job is submitted). Their credits
 * ARE freed by step 1 above (the reservation has a createdAt). The analysis
 * row will remain showing as "queued" in the UI until the user retries.
 * A future migration adding createdAt to analyses would allow full cleanup.
 *
 * ── Cutoff calculation ────────────────────────────────────────────────────────
 *
 *   cutoff = jobTimeoutMs × maxAttempts × safetyMultiplier
 *
 * With production defaults:
 *   20 min  ×  3 attempts  ×  2×  =  120 min  (2 hours)
 *
 * Any reservation older than 2 hours is guaranteed to have outlived every
 * possible retry window. Releasing it cannot race with a legitimate
 * finalizeCredits() call because the conditional UPDATE enforces idempotency.
 */
export async function sweepStaleReservations(): Promise<{
  reservationsReleased: number;
  analysesMarkedFailed: number;
}> {
  const cutoffMs = config.analysis.staleReservationCutoffMs;
  const cutoff = new Date(Date.now() - cutoffMs);

  let reservationsReleased = 0;
  let analysesMarkedFailed = 0;

  // ── 1. Release stale credit reservations ───────────────────────────────────

  const staleReservations = await db
    .select({
      id: schema.creditReservations.id,
      userId: schema.creditReservations.userId,
      subscriptionId: schema.creditReservations.subscriptionId,
      reservedAmount: schema.creditReservations.reservedAmount,
      createdAt: schema.creditReservations.createdAt,
    })
    .from(schema.creditReservations)
    .where(
      and(
        eq(schema.creditReservations.status, "reserved"),
        lt(schema.creditReservations.createdAt, cutoff)
      )
    );

  if (staleReservations.length > 0) {
    logger.warn(
      { count: staleReservations.length, cutoffMs, cutoff },
      "sweeper.stale_reservations_found — releasing credits"
    );

    for (const reservation of staleReservations) {
      try {
        await releaseReservation(
          reservation.userId,
          reservation.subscriptionId,
          reservation.id,
          reservation.reservedAmount
        );
        reservationsReleased++;
        logger.info(
          {
            reservationId: reservation.id,
            userId: reservation.userId,
            reservedAmount: reservation.reservedAmount,
            ageMs: Date.now() - reservation.createdAt.getTime(),
          },
          "sweeper.reservation_released"
        );
      } catch (err) {
        // Log and continue — a failed release is not fatal. The next sweep
        // will retry it (releaseReservation is idempotent).
        logger.error(
          { reservationId: reservation.id, userId: reservation.userId, err },
          "sweeper.release_failed"
        );
      }
    }
  }

  // ── 2. Mark stale "processing" analyses as failed ──────────────────────────
  //
  // An analysis in "processing" state has a startedAt timestamp (set by the
  // worker when it picks up the job). If the worker died mid-job and the job
  // was not re-queued (e.g. Redis restart wiped it), startedAt will remain
  // in the past forever.
  //
  // SQL: startedAt IS NOT NULL is implicit — NULL < cutoff evaluates to NULL
  // (unknown) in SQL, so NULL rows are excluded by the WHERE clause naturally.

  const staleAnalyses = await db
    .select({ id: schema.analyses.id })
    .from(schema.analyses)
    .where(
      and(
        eq(schema.analyses.status, "processing"),
        lt(schema.analyses.startedAt, cutoff)
      )
    );

  if (staleAnalyses.length > 0) {
    const staleIds = staleAnalyses.map((a) => a.id);

    await db
      .update(schema.analyses)
      .set({
        status: "failed",
        error:
          "Analysis was interrupted and could not be recovered (the job may have been " +
          "lost due to a Redis restart). Your credits have been returned. " +
          "Please retry your analysis.",
        completedAt: new Date(),
      })
      .where(inArray(schema.analyses.id, staleIds));

    analysesMarkedFailed = staleAnalyses.length;
    logger.warn(
      { count: analysesMarkedFailed, ids: staleIds },
      "sweeper.analyses_marked_failed"
    );
  }

  if (reservationsReleased === 0 && analysesMarkedFailed === 0) {
    logger.debug({ cutoffMs }, "sweeper.nothing_stale — no action taken");
  }

  return { reservationsReleased, analysesMarkedFailed };
}

/**
 * Starts the stale reservation sweeper on a periodic interval.
 *
 * Runs one pass immediately at startup to catch any reservations that
 * became stale during a downtime or Redis restart, then repeats at the
 * configured interval (default: every hour).
 *
 * Call stopStaleReservationSweeper() for a clean shutdown.
 */
export function startStaleReservationSweeper(): NodeJS.Timeout {
  const intervalMs = config.analysis.staleReservationSweepIntervalMs;

  const run = () => {
    sweepStaleReservations().catch((err) => {
      logger.error({ err }, "sweeper.run_error");
    });
  };

  // Run immediately so credits from any pre-startup stale reservations
  // are freed before the first user request arrives.
  run();

  return setInterval(run, intervalMs);
}

export function stopStaleReservationSweeper(timer: NodeJS.Timeout): void {
  clearInterval(timer);
}
