import { eq, and, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { CREDIT_COSTS, getPlan, type PlanId } from "../types";
import { logger } from "./logger";

/* ── Credit Estimation ────────────────────────────── */

export function estimateCredits(
  pageCount: number = 1,
  includeRedlines: boolean = false,
  clauseCount: number = 6
): number {
  const analysisCost = Math.min(
    CREDIT_COSTS.ANALYSIS_MAX,
    Math.max(CREDIT_COSTS.ANALYSIS_MIN, CREDIT_COSTS.ANALYSIS_MIN + pageCount)
  );

  let total = analysisCost;

  if (includeRedlines) {
    total += clauseCount * CREDIT_COSTS.REDLINE;
  }

  return total;
}

/* ── Balance Check (advisory, no lock) ───────────────
 *
 * Read-only snapshot for display / pre-flight UX.
 * Does NOT enforce anything — reserveCredits() is the
 * enforcing function and acquires a row lock.
 *
 * Accounts for credits_reserved so users can see that
 * in-flight analyses have already claimed some credits.
 *
 * Applies uniformly to all plans — there is no overage
 * billing, so no plan may exceed its allocation.
 * ────────────────────────────────────────────────────── */

export async function checkBalance(
  userId: string,
  estimatedCredits: number
): Promise<{ allowed: boolean; reason?: string }> {
  const [sub] = await db
    .select()
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.userId, userId),
        eq(schema.subscriptions.status, "active")
      )
    )
    .limit(1);

  if (!sub) {
    return { allowed: false, reason: "No active subscription found" };
  }

  const plan = getPlan(sub.planId as PlanId);

  const [usage] = await db
    .select()
    .from(schema.creditUsage)
    .where(
      and(
        eq(schema.creditUsage.userId, userId),
        eq(schema.creditUsage.subscriptionId, sub.id)
      )
    )
    .limit(1);

  const creditsUsed = usage?.creditsUsed ?? 0;
  const creditsReserved = usage?.creditsReserved ?? 0;
  const available = plan.credits - creditsUsed - creditsReserved;

  if (available < estimatedCredits) {
    return {
      allowed: false,
      reason: available <= 0
        ? "You have no credits remaining. Your allowance resets at the start of your next billing period."
        : `Insufficient credits. Need ~${estimatedCredits}, have ${available}.`,
    };
  }

  return { allowed: true };
}

/* ── Credit Reservation ───────────────────────────────
 *
 * State machine: reserved → consumed (finalizeCredits)
 *                         → released (releaseReservation)
 *
 * Creates one row in credit_reservations per analysis.
 * All subsequent transitions use a conditional UPDATE
 * WHERE status = 'reserved' — if 0 rows are updated the
 * transition is rejected, making every operation idempotent.
 *
 * Returns both subscriptionId (pinned billing row) and
 * reservationId (idempotency key) so the worker can target
 * the exact reservation even if the subscription changes.
 *
 * Invariant enforced: creditsUsed + creditsReserved ≤ plan.credits
 * This check is applied to ALL plans — there is no overage billing.
 * ────────────────────────────────────────────────────── */

export async function reserveCredits(
  userId: string,
  amount: number
): Promise<{
  success: boolean;
  error?: string;
  subscriptionId?: string;
  reservationId?: string;
}> {
  try {
    const result = await db.transaction(async (tx) => {
      const [sub] = await tx
        .select()
        .from(schema.subscriptions)
        .where(
          and(
            eq(schema.subscriptions.userId, userId),
            eq(schema.subscriptions.status, "active")
          )
        )
        .for("update")
        .limit(1);

      if (!sub) {
        return { success: false as const, error: "No active subscription" };
      }

      const plan = getPlan(sub.planId as PlanId);

      let [usage] = await tx
        .select()
        .from(schema.creditUsage)
        .where(
          and(
            eq(schema.creditUsage.userId, userId),
            eq(schema.creditUsage.subscriptionId, sub.id)
          )
        )
        .for("update")
        .limit(1);

      if (!usage) {
        const [newUsage] = await tx
          .insert(schema.creditUsage)
          .values({
            userId,
            subscriptionId: sub.id,
            creditsUsed: 0,
            creditsReserved: 0,
            creditsRemaining: plan.credits,
            overageCredits: 0,
            overageCost: "0",
            periodStart: sub.currentPeriodStart,
            periodEnd: sub.currentPeriodEnd,
          })
          .returning();
        usage = newUsage;
      }

      // Checked AFTER locking — no stale reads possible.
      // Applied to ALL plans: there is no overage billing, so no plan may
      // reserve more credits than it has available.
      const available = plan.credits - usage.creditsUsed - usage.creditsReserved;

      if (amount > available) {
        logger.warn(
          { userId, planId: sub.planId, needed: amount, available },
          "credits.insufficient"
        );
        return {
          success: false as const,
          error: available <= 0
            ? "You have no credits remaining. Your allowance resets at the start of your next billing period."
            : `Insufficient credits. Need ${amount}, have ${available}.`,
        };
      }

      // Create the reservation row — the canonical record for this lock.
      // status defaults to 'reserved' via schema default.
      const [reservation] = await tx
        .insert(schema.creditReservations)
        .values({
          userId,
          subscriptionId: sub.id,
          reservedAmount: amount,
        })
        .returning();

      // Update the aggregate counter so creditsRemaining reflects the lock.
      const newReserved = usage.creditsReserved + amount;
      const newRemaining = Math.max(0, plan.credits - usage.creditsUsed - newReserved);

      await tx
        .update(schema.creditUsage)
        .set({ creditsReserved: newReserved, creditsRemaining: newRemaining })
        .where(eq(schema.creditUsage.id, usage.id));

      return {
        success: true as const,
        subscriptionId: sub.id,
        reservationId: reservation.id,
      };
    });

    return result;
  } catch (error) {
    logger.error({ err: error }, "credits.reserve_error");
    return { success: false, error: "Credit reservation failed due to a database error" };
  }
}

/* ── Finalize Credits ─────────────────────────────────
 *
 * Called by the worker on successful completion.
 *
 * Atomically transitions: reserved → consumed
 *
 * The conditional UPDATE WHERE status = 'reserved' is the
 * state-machine gate. If 0 rows are updated the reservation
 * was already consumed or released — return success:false so
 * the worker does NOT double-deduct from credit_usage.
 *
 * actualAmount may differ from reservedAmount (estimate vs
 * real clause count). It is capped at the plan's remaining
 * headroom so creditsUsed can never exceed plan.credits,
 * regardless of estimation error.
 *
 * Invariant maintained: creditsUsed + creditsReserved ≤ plan.credits
 * ────────────────────────────────────────────────────── */

export async function finalizeCredits(
  userId: string,
  subscriptionId: string,
  reservationId: string,
  reservedAmount: number,
  actualAmount: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await db.transaction(async (tx) => {
      // Atomic state transition: reserved → consumed.
      // Returns the row only if it was in 'reserved' state.
      const transitioned = await tx
        .update(schema.creditReservations)
        .set({
          status: "consumed",
          actualAmount,
          resolvedAt: new Date(),
        })
        .where(
          and(
            eq(schema.creditReservations.id, reservationId),
            eq(schema.creditReservations.status, "reserved")
          )
        )
        .returning({ id: schema.creditReservations.id });

      if (transitioned.length === 0) {
        // Reservation already consumed or released — idempotent no-op.
        logger.warn({ reservationId, userId }, "credits.finalize_rejected_wrong_state");
        return {
          success: false as const,
          error: "Reservation already consumed or released — finalize rejected",
        };
      }

      // Subscription looked up by ID (not status) so an upgrade between
      // queue time and completion doesn't misdirect the deduction.
      const [sub] = await tx
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.id, subscriptionId))
        .for("update")
        .limit(1);

      if (!sub) {
        return {
          success: false as const,
          error: `Subscription ${subscriptionId} not found`,
        };
      }

      const plan = getPlan(sub.planId as PlanId);

      const [usage] = await tx
        .select()
        .from(schema.creditUsage)
        .where(
          and(
            eq(schema.creditUsage.userId, userId),
            eq(schema.creditUsage.subscriptionId, subscriptionId)
          )
        )
        .for("update")
        .limit(1);

      if (!usage) {
        return { success: false as const, error: "Credit usage record not found" };
      }

      const newReserved = Math.max(0, usage.creditsReserved - reservedAmount);

      // Cap actualAmount at the headroom left in the plan.
      //
      // Normally actualAmount ≤ reservedAmount and this cap is a no-op.
      // The edge case is when actual clause count significantly exceeds the
      // pre-analysis estimate (estimate: max(6, pages×3); actual: real count).
      // Without the cap, a large estimate error could push creditsUsed above
      // plan.credits. Since we do not bill overage, clamping is the correct
      // behaviour — users never get charged more than their plan allows.
      const headroom = Math.max(0, plan.credits - usage.creditsUsed);
      const effectiveActual = Math.min(actualAmount, headroom);

      const newUsed = usage.creditsUsed + effectiveActual;
      const newRemaining = Math.max(0, plan.credits - newUsed - newReserved);

      // Log when the cap fires so we can monitor estimate accuracy.
      if (effectiveActual < actualAmount) {
        logger.warn(
          { userId, reservationId, actualAmount, effectiveActual, headroom },
          "credits.actual_capped_at_plan_limit"
        );
      }

      await tx
        .update(schema.creditUsage)
        .set({
          creditsUsed: newUsed,
          creditsReserved: newReserved,
          creditsRemaining: newRemaining,
          // No overage billing: always zero.
          overageCredits: 0,
          overageCost: "0",
        })
        .where(eq(schema.creditUsage.id, usage.id));

      return { success: true as const };
    });

    return result;
  } catch (error) {
    logger.error({ err: error }, "credits.finalize_error");
    return { success: false, error: "Credit finalization failed due to a database error" };
  }
}

/* ── Release Reservation ──────────────────────────────
 *
 * Called by the worker on final failure (all BullMQ
 * retry attempts exhausted).
 *
 * Atomically transitions: reserved → released
 *
 * Same guard as finalizeCredits: conditional UPDATE
 * WHERE status = 'reserved'. A second call (double-release)
 * or a call after finalize (release-after-consume) updates
 * 0 rows and is silently ignored — the balance is already
 * correct and the caller has nothing to clean up.
 *
 * NOT called on intermediate failures — the reservation
 * stays locked during the retry window so a concurrent
 * submission cannot race the retry and overdraw the balance.
 * ────────────────────────────────────────────────────── */

export async function releaseReservation(
  userId: string,
  subscriptionId: string,
  reservationId: string,
  reservedAmount: number
): Promise<void> {
  await db.transaction(async (tx) => {
    // Atomic state transition: reserved → released.
    const transitioned = await tx
      .update(schema.creditReservations)
      .set({
        status: "released",
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(schema.creditReservations.id, reservationId),
          eq(schema.creditReservations.status, "reserved")
        )
      )
      .returning({ id: schema.creditReservations.id });

    if (transitioned.length === 0) {
      // Already consumed or released — nothing to return to balance.
      logger.warn({ reservationId, userId }, "credits.release_rejected_wrong_state");
      return;
    }

    const [sub] = await tx
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.id, subscriptionId))
      .for("update")
      .limit(1);

    if (!sub) return;

    const plan = getPlan(sub.planId as PlanId);

    const [usage] = await tx
      .select()
      .from(schema.creditUsage)
      .where(
        and(
          eq(schema.creditUsage.userId, userId),
          eq(schema.creditUsage.subscriptionId, subscriptionId)
        )
      )
      .for("update")
      .limit(1);

    if (!usage) return;

    const newReserved = Math.max(0, usage.creditsReserved - reservedAmount);
    const newRemaining = Math.max(0, plan.credits - usage.creditsUsed - newReserved);

    await tx
      .update(schema.creditUsage)
      .set({ creditsReserved: newReserved, creditsRemaining: newRemaining })
      .where(eq(schema.creditUsage.id, usage.id));
  });
}

/* ── Get User Credit Info ─────────────────────────── */

export async function getUserCreditInfo(userId: string): Promise<{
  creditsUsed: number;
  creditsReserved: number;
  creditsRemaining: number;
  creditsTotal: number;
  overageCredits: number;
  overageCost: number;
  periodStart: string;
  periodEnd: string;
  planId: PlanId;
  planName: string;
  canRedline: boolean;
  canRewrite: boolean;
} | null> {
  const [sub] = await db
    .select()
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.userId, userId),
        eq(schema.subscriptions.status, "active")
      )
    )
    .limit(1);

  if (!sub) return null;

  const plan = getPlan(sub.planId as PlanId);

  const [usage] = await db
    .select()
    .from(schema.creditUsage)
    .where(
      and(
        eq(schema.creditUsage.userId, userId),
        eq(schema.creditUsage.subscriptionId, sub.id)
      )
    )
    .limit(1);

  const creditsUsed = usage?.creditsUsed ?? 0;
  const creditsReserved = usage?.creditsReserved ?? 0;
  const creditsRemaining = Math.max(0, plan.credits - creditsUsed - creditsReserved);
  const overageCredits = usage?.overageCredits ?? 0;
  const overageCost = usage ? parseFloat(String(usage.overageCost)) : 0;

  return {
    creditsUsed,
    creditsReserved,
    creditsRemaining,
    creditsTotal: plan.credits,
    overageCredits,
    overageCost,
    periodStart: sub.currentPeriodStart.toISOString().slice(0, 10),
    periodEnd: sub.currentPeriodEnd.toISOString().slice(0, 10),
    planId: sub.planId as PlanId,
    planName: plan.name,
    canRedline: sub.planId !== "free",
    canRewrite: sub.planId === "professional" || sub.planId === "enterprise",
  };
}
