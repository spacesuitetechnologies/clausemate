import { Router, Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import type { PostgresError } from "postgres";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { verifyWebhookSignature } from "../services/razorpay";
import { getPlan, type PlanId } from "../types";
import { logger } from "../services/logger";

const router = Router();

/* ── Razorpay Webhook Types ───────────────────────── */

interface RazorpaySubscriptionEntity {
  id: string;
  plan_id: string;
  status: string;
  current_start: number | null;
  current_end: number | null;
}

interface RazorpayPaymentEntity {
  id: string;
  amount: number;
  currency: string;
}

interface RazorpayWebhookPayload {
  entity: "event";
  account_id: string;
  event: string;
  contains: string[];
  payload: {
    subscription?: { entity: RazorpaySubscriptionEntity };
    payment?: { entity: RazorpayPaymentEntity };
  };
}

/* ── Duplicate detection ──────────────────────────── */

/**
 * Returns true when `err` is a Postgres unique-constraint violation (23505).
 *
 * postgres-js surfaces this as a PostgresError with `.code === '23505'`.
 * We also fall back to checking the message so tests using plain Error
 * objects still work without needing a real Postgres connection.
 */
function isDuplicateKeyError(err: unknown): boolean {
  if (err && typeof err === "object") {
    if ((err as PostgresError).code === "23505") return true;
    // Fallback: message-based detection for environments without real PG
    const msg = (err as Error).message ?? "";
    if (msg.includes("duplicate key") || msg.includes("unique constraint")) return true;
  }
  return false;
}

/* ── POST /webhook/razorpay ───────────────────────── */
// NOTE: Registered with express.raw() in index.ts — req.body is a Buffer.

router.post("/razorpay", async (req: Request, res: Response): Promise<void> => {

  // ── 1. Verify signature ──────────────────────────
  const signature = req.headers["x-razorpay-signature"] as string | undefined;
  if (!signature) {
    res.status(400).json({ error: "Missing signature" });
    return;
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    res.status(400).json({ error: "Empty or invalid body" });
    return;
  }

  let isValid = false;
  try {
    isValid = verifyWebhookSignature(rawBody, signature);
  } catch (err) {
    req.log.error({ err }, "webhook.signature_error");
    res.status(500).json({ error: "Signature verification failed" });
    return;
  }

  if (!isValid) {
    req.log.warn("webhook.invalid_signature");
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  // ── 2. Parse payload ─────────────────────────────
  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid JSON payload" });
    return;
  }

  const eventType = payload.event;
  const subscriptionEntity = payload.payload.subscription?.entity;
  const paymentEntity = payload.payload.payment?.entity;

  // ── 3. Idempotency key ───────────────────────────
  //
  //   invoice.paid       → paymentEntity.id  (pay_xxx)
  //     Each billing cycle produces a new pay_xxx. Using sub_xxx would
  //     cause month-2+ renewals to collide with month-1 and be dropped,
  //     starving users of their monthly credits.
  //
  //   subscription.*     → subscriptionEntity.id  (sub_xxx)
  //     One-time lifecycle transitions tied to the subscription.
  //
  const entityId =
    eventType === "invoice.paid" && paymentEntity?.id
      ? paymentEntity.id
      : subscriptionEntity?.id ?? paymentEntity?.id ?? "unknown";
  const eventId = `${eventType}:${entityId}`;

  req.log.info({ eventId, eventType }, "webhook.received");

  // ── 4. Process inside a single transaction ───────
  //
  // The idempotency INSERT is the FIRST statement inside the transaction.
  // If it violates the unique constraint (duplicate delivery) the whole
  // transaction rolls back before any business state changes — no partial
  // updates are possible and no manual cleanup is needed.
  //
  // If business logic throws after the INSERT, postgres rolls back the
  // idempotency row too. Razorpay retries will find no row and reprocess,
  // which is exactly what we want.
  //
  // This replaces the old insert-then-delete-on-failure pattern, which
  // was racy: a process crash between the failure and the delete left
  // the event permanently marked as processed with no business effect.
  //
  try {
    await db.transaction(async (tx) => {

      // Idempotency gate: unique constraint on event_id enforces exactly-once.
      // Throws 23505 on duplicate → caught below → 200 "duplicate" response.
      await tx.insert(schema.webhookEvents).values({ eventId, eventType });

      switch (eventType) {

        // ── subscription.activated ──────────────────
        // Fired when subscription first activates (before first payment).
        // Credits are NOT allocated here — wait for invoice.paid.
        case "subscription.activated": {
          if (!subscriptionEntity) break;

          const [sub] = await tx
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.razorpaySubscriptionId, subscriptionEntity.id))
            .for("update")
            .limit(1);

          if (!sub) {
            logger.warn({ razorpaySubscriptionId: subscriptionEntity.id }, "billing.subscription_not_found");
            break;
          }

          if (sub.status !== "active") {
            await tx
              .update(schema.subscriptions)
              .set({ status: "active" })
              .where(eq(schema.subscriptions.id, sub.id));
            req.log.info({ razorpaySubscriptionId: subscriptionEntity.id }, "billing.subscription_activated");
          }
          break;
        }

        // ── invoice.paid ────────────────────────────
        // Fired after each successful payment (initial + renewals).
        // Resets the credit usage row for the new billing period.
        case "invoice.paid": {
          if (!subscriptionEntity || !paymentEntity) break;

          const currentStart = subscriptionEntity.current_start
            ? new Date(subscriptionEntity.current_start * 1000)
            : new Date();
          const currentEnd = subscriptionEntity.current_end
            ? new Date(subscriptionEntity.current_end * 1000)
            : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);

          // Lock the subscription row for the duration of this transaction.
          // Prevents a concurrent invoice.paid delivery from running the
          // credit reset twice against the same row.
          const [sub] = await tx
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.razorpaySubscriptionId, subscriptionEntity.id))
            .for("update")
            .limit(1);

          if (!sub) {
            logger.warn({ razorpaySubscriptionId: subscriptionEntity.id }, "billing.subscription_not_found");
            break;
          }

          // Secondary idempotency check: the webhook_events row above is the
          // primary guard, but if somehow the same invoice appears under a
          // different event ID we still skip rather than double-allocate.
          if (sub.lastInvoiceId === paymentEntity.id) {
            req.log.info({ invoiceId: paymentEntity.id, userId: sub.userId }, "billing.invoice_duplicate_skipped");
            break;
          }

          const plan = getPlan(sub.planId as PlanId);

          await tx
            .update(schema.subscriptions)
            .set({
              status: "active",
              lastInvoiceId: paymentEntity.id,
              currentPeriodStart: currentStart,
              currentPeriodEnd: currentEnd,
            })
            .where(eq(schema.subscriptions.id, sub.id));

          // Upsert credit usage: reset all counters for the new billing period.
          //
          // creditsReserved is zeroed intentionally — see the comment block in
          // the original allocateCreditsForSubscription for the full rationale.
          const [existingUsage] = await tx
            .select()
            .from(schema.creditUsage)
            .where(
              and(
                eq(schema.creditUsage.userId, sub.userId),
                eq(schema.creditUsage.subscriptionId, sub.id)
              )
            )
            .for("update")
            .limit(1);

          // Warn if in-flight analyses are mid-billing-period — their reservations
          // will be zeroed out by the reset below. These analyses are still running
          // (the BullMQ job exists) and will call finalizeCredits() against the
          // new period's balance. The stale-reservation sweeper will clean up any
          // orphaned reservations that survive the period boundary.
          if (existingUsage && existingUsage.creditsReserved > 0) {
            req.log.warn(
              {
                userId: sub.userId,
                subscriptionId: sub.id,
                creditsReserved: existingUsage.creditsReserved,
                invoiceId: paymentEntity.id,
              },
              "billing.period_reset_with_active_reservations — in-flight analyses at period boundary; credits_reserved zeroed"
            );
          }

          const usageValues = {
            creditsUsed: 0,
            creditsReserved: 0,
            creditsRemaining: plan.credits,
            overageCredits: 0,
            overageCost: "0",
            periodStart: currentStart,
            periodEnd: currentEnd,
          };

          if (existingUsage) {
            await tx
              .update(schema.creditUsage)
              .set(usageValues)
              .where(eq(schema.creditUsage.id, existingUsage.id));
          } else {
            await tx.insert(schema.creditUsage).values({
              userId: sub.userId,
              subscriptionId: sub.id,
              ...usageValues,
            });
          }

          req.log.info(
            { userId: sub.userId, planId: sub.planId, credits: plan.credits, invoiceId: paymentEntity.id },
            "billing.credits_allocated"
          );
          break;
        }

        // ── subscription.cancelled / completed ──────
        case "subscription.cancelled":
        case "subscription.completed": {
          if (!subscriptionEntity) break;

          await tx
            .update(schema.subscriptions)
            .set({ status: "cancelled" })
            .where(eq(schema.subscriptions.razorpaySubscriptionId, subscriptionEntity.id));

          req.log.info({ razorpaySubscriptionId: subscriptionEntity.id, eventType }, "billing.subscription_cancelled");
          break;
        }

        // ── subscription.halted ─────────────────────
        // Payment failed multiple times.
        case "subscription.halted": {
          if (!subscriptionEntity) break;

          await tx
            .update(schema.subscriptions)
            .set({ status: "past_due" })
            .where(eq(schema.subscriptions.razorpaySubscriptionId, subscriptionEntity.id));

          req.log.warn({ razorpaySubscriptionId: subscriptionEntity.id }, "billing.subscription_halted");
          break;
        }

        default:
          req.log.debug({ eventType }, "webhook.unhandled_event");
      }
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      // Unique constraint on webhook_events.event_id fired — duplicate delivery.
      // Return 200 so Razorpay stops retrying this event.
      req.log.info({ eventId, eventType }, "webhook.duplicate_skipped");
      res.json({ status: "duplicate" });
      return;
    }

    // Genuine processing error — transaction rolled back atomically, including
    // the idempotency row. Razorpay will retry and we will reprocess correctly.
    req.log.error({ eventId, eventType, err }, "webhook.processing_error");
    res.status(500).json({ error: "Webhook processing failed" });
    return;
  }

  req.log.info({ eventId, eventType }, "webhook.processed");
  res.json({ status: "ok" });
});

export default router;
