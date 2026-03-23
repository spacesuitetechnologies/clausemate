import { Router, Request, Response } from "express";
import { z } from "zod";
import { eq, and, or } from "drizzle-orm";
import { createHash } from "crypto";
import { config } from "../config";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { authMiddleware } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { getUserCreditInfo } from "../services/creditSystem";
import { getRazorpay, verifyPaymentSignature, getRazorpayPlanId, isRazorpayConfigured } from "../services/razorpay";
import { getPlan, type PlanId } from "../types";
import { logger } from "../services/logger";

const router = Router();

/* ── POST /billing/create-subscription ────────────── */

const createSubscriptionSchema = z.object({
  plan_id: z.enum(["starter", "professional", "enterprise"]),
});

router.post(
  "/create-subscription",
  authMiddleware,
  validate(createSubscriptionSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (!isRazorpayConfigured()) {
        res.status(503).json({ error: "Payment system is not configured" });
        return;
      }

      const userId = req.userId!;
      const { plan_id: planId } = req.body as { plan_id: "starter" | "professional" | "enterprise" };

      // ── Step 1: Pre-flight read — reject obvious duplicates before touching Razorpay.
      //
      //           This is a non-locking read. It catches the common case (user
      //           clicks "Upgrade" twice, or navigates back and resubmits). For the
      //           true race (two requests arrive within milliseconds of each other)
      //           the partial UNIQUE index on subscriptions (userId) WHERE status IN
      //           ('active','trialing') is the hard DB backstop — it fires on the
      //           losing INSERT and we surface it as 409.

      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const [existingSub] = await db
        .select()
        .from(schema.subscriptions)
        .where(
          and(
            eq(schema.subscriptions.userId, userId),
            or(
              eq(schema.subscriptions.status, "active"),
              eq(schema.subscriptions.status, "trialing")
            )
          )
        )
        .limit(1);

      if (existingSub) {
        logger.warn(
          { userId, existingSubId: existingSub.id, existingStatus: existingSub.status, requestedPlanId: planId },
          "billing.duplicate_subscription_rejected"
        );
        res.status(409).json({
          error: "You already have an active subscription. Please cancel it before upgrading.",
          existing_subscription_id: existingSub.razorpaySubscriptionId,
          existing_plan_id: existingSub.planId,
          existing_status: existingSub.status,
        });
        return;
      }

      const razorpay = getRazorpay();

      // ── Step 2: Create or reuse Razorpay customer (idempotent — fail_existing: 0)

      let razorpayCustomerId = user.razorpayCustomerId;
      if (!razorpayCustomerId) {
        // Razorpay SDK types declare the return as `Promise<RazorpayCustomer> & void`
        // which TypeScript cannot directly cast to a concrete shape. Cast through
        // `unknown` first — the runtime value is a plain customer object with `id`.
        const customer = await razorpay.customers.create({
          name: user.name,
          email: user.email,
          fail_existing: 0 as const, // reuse if a customer with this email already exists
        }) as unknown as { id: string };
        razorpayCustomerId = customer.id;

        await db
          .update(schema.users)
          .set({ razorpayCustomerId })
          .where(eq(schema.users.id, userId));
      }

      // ── Step 3: Call Razorpay with a deterministic idempotency key.
      //
      //           A network retry, client double-click, or BullMQ job retry
      //           all produce the same key → Razorpay returns the existing
      //           subscription instead of creating a second one.
      //
      //           Key: SHA-256(userId:planId) truncated to 40 hex chars.
      //           Razorpay deduplicates within a rolling 24-hour window.

      const razorpayPlanId = getRazorpayPlanId(planId);
      const idempotencyKey = createHash("sha256")
        .update(`${userId}:${planId}`)
        .digest("hex")
        .slice(0, 40);

      const rzSub = await (razorpay.subscriptions.create as (
        params: object,
        options?: object
      ) => Promise<{ id: string; status: string }>)(
        {
          plan_id: razorpayPlanId,
          customer_notify: 1 as const,
          quantity: 1,
          total_count: 12, // 12 monthly billing cycles
          addons: [],
          notes: { userId, planId },
        },
        { idempotencyKey }
      );

      // ── Step 4: Persist the new subscription atomically.
      //
      //           The Razorpay subscription already exists on their side.
      //           If the transaction rolls back, the Razorpay subscription becomes
      //           an orphan (recoverable via webhook or support) — far safer than
      //           the user losing all access.
      //
      //           Inside the transaction we lock the user's existing subs with
      //           FOR UPDATE before cancelling them, so a concurrent request that
      //           passed the pre-flight read above cannot slip in between.
      //
      //           If the partial UNIQUE index fires (true concurrent race), we
      //           catch the error and return 409 rather than 500.

      const now = new Date();
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      try {
        await db.transaction(async (tx) => {
          // Lock existing active/trialing rows before cancelling — this is the
          // serialisation point for concurrent requests that both passed the
          // pre-flight check above.
          await tx
            .select({ id: schema.subscriptions.id })
            .from(schema.subscriptions)
            .where(
              and(
                eq(schema.subscriptions.userId, userId),
                or(
                  eq(schema.subscriptions.status, "active"),
                  eq(schema.subscriptions.status, "trialing")
                )
              )
            )
            .for("update");

          await tx
            .update(schema.subscriptions)
            .set({ status: "cancelled" })
            .where(
              and(
                eq(schema.subscriptions.userId, userId),
                or(
                  eq(schema.subscriptions.status, "active"),
                  eq(schema.subscriptions.status, "trialing")
                )
              )
            );

          await tx.insert(schema.subscriptions).values({
            userId,
            planId,
            status: "trialing",
            razorpaySubscriptionId: rzSub.id,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          });
        });
      } catch (txError: unknown) {
        // Unique-index violation → a concurrent request won the race.
        // The client should refresh and re-evaluate before retrying.
        const msg = txError instanceof Error ? txError.message : String(txError);
        if (msg.includes("subscriptions_one_active_per_user_idx")) {
          logger.warn(
            { userId, planId, rzSubId: rzSub.id },
            "billing.unique_index_collision"
          );
          res.status(409).json({
            error: "A subscription was already created for this account. Please refresh and try again.",
          });
          return;
        }
        throw txError;
      }

      logger.info({ userId, planId, rzSubId: rzSub.id }, "billing.subscription_created");

      res.json({
        subscription_id: rzSub.id,
        key_id: config.razorpay.keyId,
        plan_id: planId,
        plan_name: getPlan(planId).name,
        monthly_price: getPlan(planId).monthly_price,
      });
    } catch (error) {
      req.log.error({ err: error }, "Create subscription error");
      res.status(500).json({ error: "Failed to create subscription" });
    }
  }
);

/* ── POST /billing/verify ─────────────────────────── */
// Called by the frontend after Razorpay Checkout completes.
// Verifies the payment signature. Credits are allocated by the webhook.

const verifySchema = z.object({
  razorpay_payment_id: z.string().min(1),
  razorpay_subscription_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

router.post(
  "/verify",
  authMiddleware,
  validate(verifySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

      const isValid = verifyPaymentSignature(
        razorpay_payment_id,
        razorpay_subscription_id,
        razorpay_signature
      );

      if (!isValid) {
        res.status(400).json({ error: "Invalid payment signature" });
        return;
      }

      // Confirm the subscription belongs to this user
      const userId = req.userId!;
      const [sub] = await db
        .select()
        .from(schema.subscriptions)
        .where(
          and(
            eq(schema.subscriptions.userId, userId),
            eq(schema.subscriptions.razorpaySubscriptionId, razorpay_subscription_id)
          )
        )
        .limit(1);

      if (!sub) {
        res.status(404).json({ error: "Subscription not found" });
        return;
      }

      // Credits are allocated by the webhook (invoice.paid event).
      // Return current subscription state.
      res.json({
        verified: true,
        subscription_id: razorpay_subscription_id,
        status: sub.status,
        message: "Payment verified. Your subscription will be activated shortly.",
      });
    } catch (error) {
      req.log.error({ err: error }, "Verify payment error");
      res.status(500).json({ error: "Payment verification failed" });
    }
  }
);

/* ── GET /billing/status ──────────────────────────── */

router.get(
  "/status",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const info = await getUserCreditInfo(userId);

      if (!info) {
        res.status(404).json({ error: "No billing information found" });
        return;
      }

      const plan = getPlan(info.planId);

      res.json({
        plan_id: info.planId,
        plan_name: info.planName,
        monthly_price: plan.monthly_price,
        credits_total: info.creditsTotal,
        credits_used: info.creditsUsed,
        credits_remaining: info.creditsRemaining,
        overage_credits: info.overageCredits,
        overage_cost: info.overageCost,
        period_start: info.periodStart,
        period_end: info.periodEnd,
        overage_rate: plan.overage_rate,
      });
    } catch (error) {
      req.log.error({ err: error }, "Billing status error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
