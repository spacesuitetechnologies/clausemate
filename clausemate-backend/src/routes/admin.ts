import { Router, Request, Response } from "express";
import { eq, desc, and, sql, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { adminAuthMiddleware } from "../middleware/adminAuth";
import { collectMetrics } from "../services/adminMetrics";

const router = Router();

// All admin routes require the API key.
router.use(adminAuthMiddleware);

/* ── GET /admin/stats ─────────────────────────────── */
// Full metrics dashboard snapshot. All queries run in parallel.

router.get("/stats", async (req: Request, res: Response): Promise<void> => {
  try {
    const metrics = await collectMetrics();
    res.json(metrics);
  } catch (error) {
    req.log.error({ err: error }, "admin.stats_error");
    res.status(500).json({ error: "Failed to collect metrics" });
  }
});

/* ── GET /admin/failed-analyses ───────────────────── */
// Paginated list of failed analyses with error details.
// Useful for investigating persistent failures without needing DB access.
//
// Query params:
//   limit  (default 20, max 100)
//   offset (default 0)

router.get("/failed-analyses", async (req: Request, res: Response): Promise<void> => {
  try {
    const limit  = Math.min(100, Math.max(1, parseInt(String(req.query.limit  ?? "20"), 10) || 20));
    const offset = Math.max(0,               parseInt(String(req.query.offset ?? "0"),  10) || 0);

    const [countRow, rows] = await Promise.all([

      db.select({ total: sql<number>`cast(count(*) as integer)` })
        .from(schema.analyses)
        .where(eq(schema.analyses.status, "failed"))
        .then(([r]) => r.total),

      db.select({
        id:               schema.analyses.id,
        userId:           schema.analyses.userId,
        contractId:       schema.analyses.contractId,
        error:            schema.analyses.error,
        completedAt:      schema.analyses.completedAt,
        creditsEstimated: schema.analyses.creditsEstimated,
        includeRedlines:  schema.analyses.includeRedlines,
      })
        .from(schema.analyses)
        .where(eq(schema.analyses.status, "failed"))
        .orderBy(desc(schema.analyses.completedAt))
        .limit(limit)
        .offset(offset),
    ]);

    res.json({
      total:  countRow,
      limit,
      offset,
      items: rows.map((r) => ({
        analysis_id:       r.id,
        user_id:           r.userId,
        contract_id:       r.contractId,
        error:             r.error,
        failed_at:         r.completedAt?.toISOString() ?? null,
        credits_estimated: r.creditsEstimated,
        include_redlines:  r.includeRedlines,
      })),
    });
  } catch (error) {
    req.log.error({ err: error }, "admin.failed_analyses_error");
    res.status(500).json({ error: "Failed to query failed analyses" });
  }
});

/* ── GET /admin/users ─────────────────────────────── */
// Paginated user list with their plan and credit status.
// Useful for support lookups and billing audits.
//
// Query params:
//   limit  (default 20, max 100)
//   offset (default 0)

router.get("/users", async (req: Request, res: Response): Promise<void> => {
  try {
    const limit  = Math.min(100, Math.max(1, parseInt(String(req.query.limit  ?? "20"), 10) || 20));
    const offset = Math.max(0,               parseInt(String(req.query.offset ?? "0"),  10) || 0);

    const [countRow, rows] = await Promise.all([

      db.select({ total: sql<number>`cast(count(*) as integer)` })
        .from(schema.users)
        .then(([r]) => r.total),

      db.select({
        id:        schema.users.id,
        email:     schema.users.email,
        name:      schema.users.name,
        createdAt: schema.users.createdAt,
      })
        .from(schema.users)
        .orderBy(desc(schema.users.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    // Fetch active subscription + credit usage for these users in one query each
    const userIds = rows.map((u) => u.id);

    const [subRows, usageRows] = await Promise.all([
      userIds.length === 0 ? [] :
        db.select({
          userId: schema.subscriptions.userId,
          planId: schema.subscriptions.planId,
          status: schema.subscriptions.status,
        })
          .from(schema.subscriptions)
          .where(
            and(
              inArray(schema.subscriptions.userId, userIds),
              eq(schema.subscriptions.status, "active")
            )
          ),

      userIds.length === 0 ? [] :
        db.select({
          userId:           schema.creditUsage.userId,
          creditsRemaining: schema.creditUsage.creditsRemaining,
          creditsUsed:      schema.creditUsage.creditsUsed,
        })
          .from(schema.creditUsage)
          .innerJoin(schema.subscriptions, eq(schema.creditUsage.subscriptionId, schema.subscriptions.id))
          .where(
            and(
              inArray(schema.creditUsage.userId, userIds),
              eq(schema.subscriptions.status, "active")
            )
          ),
    ]);

    const subByUser  = new Map(subRows.map((s) => [s.userId, s]));
    const usageByUser = new Map(usageRows.map((u) => [u.userId, u]));

    res.json({
      total:  countRow,
      limit,
      offset,
      items: rows.map((u) => {
        const sub   = subByUser.get(u.id);
        const usage = usageByUser.get(u.id);
        return {
          id:                u.id,
          email:             u.email,
          name:              u.name,
          created_at:        u.createdAt.toISOString(),
          plan:              sub?.planId   ?? null,
          subscription_status: sub?.status ?? null,
          credits_remaining: usage?.creditsRemaining ?? null,
          credits_used:      usage?.creditsUsed      ?? null,
        };
      }),
    });
  } catch (error) {
    req.log.error({ err: error }, "admin.users_error");
    res.status(500).json({ error: "Failed to query users" });
  }
});

export default router;
