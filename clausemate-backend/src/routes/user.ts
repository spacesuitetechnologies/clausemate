import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { authMiddleware } from "../middleware/auth";
import { getUserCreditInfo } from "../services/creditSystem";
import { type UserPlan, type CreditUsageResponse } from "../types";
import { logger } from "../services/logger";

const router = Router();

/* ── GET /user/me ─────────────────────────────────── */

router.get(
  "/me",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const [user] = await db
        .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      res.json({ id: user.id, email: user.email, name: user.name });
    } catch (error) {
      req.log.error({ err: error }, "Get user me error");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── GET /user/plan ───────────────────────────────── */

router.get(
  "/plan",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const info = await getUserCreditInfo(userId);

      if (!info) {
        res.status(404).json({ error: "No active subscription found" });
        return;
      }

      const response: UserPlan = {
        plan_id: info.planId,
        plan_name: info.planName,
        credits_total: info.creditsTotal,
        credits_used: info.creditsUsed,
        credits_remaining: info.creditsRemaining,
        overage_credits: info.overageCredits,
        overage_cost: info.overageCost,
        can_redline: info.canRedline,
        can_rewrite: info.canRewrite,
      };

      res.json(response);
    } catch (error) {
      req.log.error({ err: error }, "Get plan error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* ── GET /user/usage ──────────────────────────────── */

router.get(
  "/usage",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const info = await getUserCreditInfo(userId);

      if (!info) {
        res.status(404).json({ error: "No active subscription found" });
        return;
      }

      const response: CreditUsageResponse = {
        credits_used: info.creditsUsed,
        credits_remaining: info.creditsRemaining,
        credits_total: info.creditsTotal,
        overage_credits: info.overageCredits,
        overage_cost: info.overageCost,
        period_start: info.periodStart,
        period_end: info.periodEnd,
      };

      res.json(response);
    } catch (error) {
      req.log.error({ err: error }, "Get usage error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/*
 * POST /user/plan has been permanently removed.
 *
 * Plan changes are ONLY permitted via the Razorpay webhook pipeline:
 *   POST /billing/create-subscription  →  Razorpay checkout
 *   →  POST /webhook/razorpay (invoice.paid)  →  credit allocation
 *
 * Any attempt to mutate plans directly via API will receive 404.
 */

export default router;
