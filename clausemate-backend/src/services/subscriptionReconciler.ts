import { eq, and, lt } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { getRazorpay, isRazorpayConfigured } from "./razorpay";
import { getPlan, type PlanId } from "../types";
import { logger } from "./logger";

/**
 * Reconciles subscriptions that are stuck in "trialing" state.
 *
 * ── Problem ─────────────────────────────────────────────────────────────────
 *
 * When a user completes the Razorpay checkout flow, Clausemate creates the
 * subscription row with status="trialing". The normal path to "active" is:
 *
 *   POST /billing/create-subscription  (status = trialing)
 *     → Razorpay fires subscription.activated  (status = active)
 *     → Razorpay fires invoice.paid            (credits allocated)
 *
 * If the webhook is not delivered (network failure, Razorpay outage, server
 * restart between checkout completion and webhook receipt), the subscription
 * stays "trialing" forever: the user paid but has no credits and their plan
 * appears inactive.
 *
 * ── Solution ─────────────────────────────────────────────────────────────────
 *
 * This reconciler runs periodically (default: every 15 minutes). For each
 * subscription stuck in "trialing" for more than 15 minutes it:
 *
 *   1. Fetches the subscription from Razorpay.
 *   2. If Razorpay reports status = "active" or "authenticated":
 *      a. Fetches invoices for the subscription to find the payment ID.
 *      b. Activates the subscription locally (idempotent — skipped if already active).
 *      c. Allocates credits using the payment ID as the lastInvoiceId key.
 *         This is the same idempotency key the invoice.paid webhook uses,
 *         so a late-arriving webhook will see lastInvoiceId already set and
 *         skip its credit allocation, preventing double-crediting.
 *
 * ── What the reconciler does NOT cover ───────────────────────────────────────
 *
 * Subscriptions where Razorpay itself never received a successful payment
 * (e.g. user abandoned checkout). These stay "trialing" until they age out
 * or the user retries. The reconciler only acts when Razorpay confirms payment.
 */

const STALE_TRIALING_CUTOFF_MS = 15 * 60 * 1000; // 15 minutes
const RECONCILER_INTERVAL_MS = 15 * 60 * 1000;    // run every 15 minutes

export async function reconcileStaleTrialingSubscriptions(): Promise<{
  checked: number;
  reconciled: number;
  errors: number;
}> {
  if (!isRazorpayConfigured()) {
    logger.debug("reconciler.skipped — Razorpay not configured");
    return { checked: 0, reconciled: 0, errors: 0 };
  }

  const cutoff = new Date(Date.now() - STALE_TRIALING_CUTOFF_MS);

  // Find subscriptions stuck in trialing beyond the cutoff.
  // currentPeriodStart is set at creation time and is always non-null.
  const staleTrialing = await db
    .select({
      id: schema.subscriptions.id,
      userId: schema.subscriptions.userId,
      planId: schema.subscriptions.planId,
      razorpaySubscriptionId: schema.subscriptions.razorpaySubscriptionId,
      lastInvoiceId: schema.subscriptions.lastInvoiceId,
      currentPeriodStart: schema.subscriptions.currentPeriodStart,
    })
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.status, "trialing"),
        lt(schema.subscriptions.currentPeriodStart, cutoff)
      )
    );

  if (staleTrialing.length === 0) {
    logger.debug("reconciler.nothing_to_reconcile");
    return { checked: 0, reconciled: 0, errors: 0 };
  }

  logger.info({ count: staleTrialing.length, cutoff }, "reconciler.stale_trialing_found");

  const razorpay = getRazorpay();
  let checked = 0;
  let reconciled = 0;
  let errors = 0;

  for (const sub of staleTrialing) {
    if (!sub.razorpaySubscriptionId) {
      // Free plan or manually-created subscription — no Razorpay record to check.
      continue;
    }

    checked++;

    try {
      // ── 1. Check subscription status in Razorpay ──────────────────────────
      const rzpSub = await razorpay.subscriptions.fetch(sub.razorpaySubscriptionId);

      if (rzpSub.status !== "active" && rzpSub.status !== "authenticated") {
        // Not yet active on Razorpay's side — nothing to reconcile.
        logger.debug(
          { subscriptionId: sub.id, razorpayStatus: rzpSub.status },
          "reconciler.not_yet_active"
        );
        continue;
      }

      // ── 2. Find the paid invoice / payment ID ─────────────────────────────
      // Fetch invoices for this subscription. The `subscription_id` filter
      // is supported by the Razorpay REST API even though the TypeScript SDK
      // types don't list it in RazorpayInvoiceQuery.
      const invoiceList = await razorpay.invoices.all({
        subscription_id: sub.razorpaySubscriptionId,
        type: "invoice",
      } as Parameters<typeof razorpay.invoices.all>[0]);

      type InvoiceItem = { status?: string; payment_id?: string | null; paid_at?: number | null };
      const items: InvoiceItem[] = (invoiceList as { items?: InvoiceItem[] }).items ?? [];
      const paidInvoices = items
        .filter((inv) => inv.status === "paid" && inv.payment_id)
        .sort((a, b) => (b.paid_at ?? 0) - (a.paid_at ?? 0));

      if (paidInvoices.length === 0) {
        // Razorpay shows the sub as active but no paid invoice found yet.
        // This can briefly happen between subscription activation and
        // invoice generation. Skip — next reconciler pass will catch it.
        logger.warn(
          { subscriptionId: sub.id, razorpaySubscriptionId: sub.razorpaySubscriptionId },
          "reconciler.active_but_no_paid_invoice — will retry next pass"
        );
        continue;
      }

      const paymentId = paidInvoices[0].payment_id!;

      // ── 3. Idempotency check ──────────────────────────────────────────────
      // If lastInvoiceId already equals this paymentId, a previous reconciler
      // pass (or a webhook) already credited this subscription. Skip.
      if (sub.lastInvoiceId === paymentId) {
        logger.debug(
          { subscriptionId: sub.id, paymentId },
          "reconciler.already_reconciled"
        );
        continue;
      }

      const plan = getPlan(sub.planId as PlanId);
      const currentStart = rzpSub.current_start
        ? new Date(rzpSub.current_start * 1000)
        : new Date(sub.currentPeriodStart);
      const currentEnd = rzpSub.current_end
        ? new Date(rzpSub.current_end * 1000)
        : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);

      // ── 4. Activate subscription and allocate credits (atomic) ───────────
      await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: schema.subscriptions.id, lastInvoiceId: schema.subscriptions.lastInvoiceId })
          .from(schema.subscriptions)
          .where(eq(schema.subscriptions.id, sub.id))
          .for("update")
          .limit(1);

        // Re-check idempotency inside the transaction (the webhook may have
        // beaten us to it between the outer read and this lock).
        if (locked?.lastInvoiceId === paymentId) {
          return;
        }

        await tx
          .update(schema.subscriptions)
          .set({
            status: "active",
            lastInvoiceId: paymentId,
            currentPeriodStart: currentStart,
            currentPeriodEnd: currentEnd,
          })
          .where(eq(schema.subscriptions.id, sub.id));

        // Upsert credit_usage — same logic as invoice.paid webhook handler.
        const [existingUsage] = await tx
          .select({ id: schema.creditUsage.id })
          .from(schema.creditUsage)
          .where(
            and(
              eq(schema.creditUsage.userId, sub.userId),
              eq(schema.creditUsage.subscriptionId, sub.id)
            )
          )
          .for("update")
          .limit(1);

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
      });

      reconciled++;
      logger.info(
        {
          subscriptionId: sub.id,
          userId: sub.userId,
          planId: sub.planId,
          credits: plan.credits,
          paymentId,
          razorpaySubscriptionId: sub.razorpaySubscriptionId,
        },
        "reconciler.subscription_activated"
      );
    } catch (err) {
      errors++;
      logger.error(
        { subscriptionId: sub.id, userId: sub.userId, razorpaySubscriptionId: sub.razorpaySubscriptionId, err },
        "reconciler.error"
      );
    }
  }

  if (reconciled > 0 || errors > 0) {
    logger.info({ checked, reconciled, errors }, "reconciler.run_complete");
  } else {
    logger.debug({ checked }, "reconciler.run_complete — nothing to reconcile");
  }

  return { checked, reconciled, errors };
}

export function startSubscriptionReconciler(): NodeJS.Timeout {
  const run = () => {
    reconcileStaleTrialingSubscriptions().catch((err) => {
      logger.error({ err }, "reconciler.run_error");
    });
  };

  // Run immediately to catch any subscriptions that became stale during downtime.
  run();

  return setInterval(run, RECONCILER_INTERVAL_MS);
}

export function stopSubscriptionReconciler(timer: NodeJS.Timeout): void {
  clearInterval(timer);
}
