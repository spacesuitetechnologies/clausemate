import { Router, Request, Response } from "express";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { authMiddleware } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { analysisRateLimit } from "../middleware/rateLimit";
import { estimateCredits, reserveCredits } from "../services/creditSystem";
import { checkMonthlyTokenCap } from "../services/llmCostGuard";
import { getStorage, getPageCount } from "../services/storage";
import { getAnalysisQueue, checkQueueCapacity } from "../workers/queue";
import { CREDIT_COSTS, type AnalysisCost } from "../types";
import { config } from "../config";
import { logger } from "../services/logger";
import { sql } from "drizzle-orm";

const router = Router();

/* ── POST /analyze ────────────────────────────────── */

const analyzeSchema = z.object({
  file_id: z.string().uuid("Invalid file ID"),
  include_redlines: z.boolean().optional().default(false),
});

router.post(
  "/",
  authMiddleware,
  analysisRateLimit,
  validate(analyzeSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const { file_id, include_redlines } = req.body;

      // ── Email verification gate ─────────────────────
      // Checked first (cheapest DB query) so unverified users get a clear
      // message rather than spending time on contract lookup / credit checks.
      const [userRow] = await db
        .select({ emailVerified: schema.users.emailVerified })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!userRow?.emailVerified) {
        res.status(403).json({
          error: "Please verify your email address before submitting an analysis. Check your inbox for the verification link.",
          code: "EMAIL_NOT_VERIFIED",
        });
        return;
      }

      // Verify contract exists and belongs to user
      const [contract] = await db
        .select()
        .from(schema.contracts)
        .where(
          and(
            eq(schema.contracts.id, file_id),
            eq(schema.contracts.userId, userId)
          )
        )
        .limit(1);

      if (!contract) {
        res.status(404).json({ error: "Contract not found" });
        return;
      }

      // ── Per-user concurrent job limit ──────────────
      // Count ALL queued|processing analyses for this user across all
      // contracts. Prevents one user from flooding the queue while
      // still being distinct from the per-contract duplicate check below.
      // Checked before the file read (expensive) to fail fast.
      const [{ userInFlight }] = await db
        .select({ userInFlight: sql<number>`cast(count(*) as integer)` })
        .from(schema.analyses)
        .where(
          and(
            eq(schema.analyses.userId, userId),
            inArray(schema.analyses.status, ["queued", "processing"])
          )
        );

      if (userInFlight >= config.analysis.maxConcurrentPerUser) {
        req.log.warn({ userId, inFlight: userInFlight, limit: config.analysis.maxConcurrentPerUser }, "analysis.concurrent_limit_reached");
        res.status(429).json({
          error: `You already have ${userInFlight} analysis job(s) in progress. Wait for them to complete before submitting more (max ${config.analysis.maxConcurrentPerUser} concurrent).`,
          in_flight: userInFlight,
        });
        return;
      }

      // ── Global queue depth limit ────────────────────
      // Reject new work when the BullMQ queue is too deep to protect
      // downstream LLM usage and prevent unbounded memory growth in Redis.
      const { available: queueAvailable, depth: queueDepth } = await checkQueueCapacity();
      if (!queueAvailable) {
        req.log.warn({ userId, queueDepth, limit: config.analysis.maxQueueDepth }, "analysis.queue_depth_limit_reached");
        res.status(503).json({
          error: "Service is busy processing other requests. Please try again in a few minutes.",
          retry_after_seconds: 60,
        });
        return;
      }

      // Reject if an analysis for this contract is already in-flight.
      //
      // Checked after contract ownership is confirmed so we don't leak
      // the existence of another user's contract via a 409 response.
      const [inFlight] = await db
        .select({ id: schema.analyses.id, status: schema.analyses.status })
        .from(schema.analyses)
        .where(
          and(
            eq(schema.analyses.contractId, contract.id),
            eq(schema.analyses.userId, userId),
            inArray(schema.analyses.status, ["queued", "processing"])
          )
        )
        .limit(1);

      if (inFlight) {
        res.status(409).json({
          error: "An analysis for this contract is already in progress",
          analysis_id: inFlight.id,
          status: inFlight.status,
        });
        return;
      }

      // ── Monthly LLM token cap ───────────────────────
      // Checked before the expensive file read so we fail fast.
      const tokenCap = await checkMonthlyTokenCap(userId);
      if (!tokenCap.ok) {
        req.log.warn({ userId, used: tokenCap.used, cap: tokenCap.cap }, "analysis.monthly_token_cap_reached");
        res.status(429).json({
          error: "Monthly LLM usage limit reached. Your token allowance resets at the start of your next billing period.",
          tokens_used: tokenCap.used,
          tokens_cap: tokenCap.cap,
        });
        return;
      }

      // Get page count for credit estimation
      const storage = getStorage();
      const fileBuffer = await storage.read(contract.storagePath);
      const pageCount = await getPageCount(fileBuffer, contract.mimeType);

      // Estimate credits
      const estimatedClauseCount = Math.max(6, pageCount * 3); // rough estimate
      const estimated = estimateCredits(pageCount, include_redlines, estimatedClauseCount);

      // Reserve credits atomically before queuing.
      //
      // This closes the TOCTOU gap between balance check and deduction:
      // concurrent submissions see each other's reservations immediately
      // (via FOR UPDATE locking in reserveCredits), so only one can win
      // if the balance is tight.
      //
      // The reservation is held until the worker completes (finalizeCredits)
      // or permanently fails (releaseReservation). Credits appear as
      // unavailable to the user the instant the job is queued.
      const reservation = await reserveCredits(userId, estimated);
      if (!reservation.success) {
        res.status(402).json({ error: reservation.error });
        return;
      }
      const { subscriptionId, reservationId } = reservation as {
        subscriptionId: string;
        reservationId: string;
      };

      // Create analysis record AFTER the reservation succeeds.
      // If this insert or the queue.add fail, we must release the reservation.
      let analysis: typeof schema.analyses.$inferSelect;
      try {
        const [row] = await db
          .insert(schema.analyses)
          .values({
            contractId: contract.id,
            userId,
            status: "queued",
            creditsEstimated: estimated,
            includeRedlines: include_redlines,
          })
          .returning();
        analysis = row;
      } catch (insertError) {
        // Always release the reservation — the analysis record was never persisted.
        try {
          const { releaseReservation } = await import("../services/creditSystem");
          await releaseReservation(userId, subscriptionId, reservationId, estimated);
        } catch (releaseError) {
          req.log.error({ err: releaseError }, "Failed to release reservation after failed insert");
        }

        // Unique index violation: two concurrent requests both passed the non-locking
        // in-flight check and both reached the INSERT. The loser hits the partial
        // UNIQUE constraint on (user_id, contract_id) WHERE status IN ('queued','processing').
        // Return 409 — same as the explicit in-flight check above.
        const msg = insertError instanceof Error ? insertError.message : String(insertError);
        const isDuplicate =
          (insertError as { code?: string }).code === "23505" ||
          msg.includes("analyses_one_inflight_per_contract_idx");
        if (isDuplicate) {
          res.status(409).json({
            error: "An analysis for this contract is already in progress",
          });
          return;
        }

        throw insertError;
      }

      // Queue the analysis job
      const queue = getAnalysisQueue();
      try {
        await queue.add(
          "analyze-contract",
          {
            analysisId: analysis.id,
            contractId: contract.id,
            userId,
            storagePath: contract.storagePath,
            mimeType: contract.mimeType,
            includeRedlines: include_redlines,
            pageCount,
            creditsEstimated: estimated,
            subscriptionId,
            reservationId,
          },
          {
            attempts: 3,
            backoff: { type: "exponential", delay: 5000 },
            removeOnComplete: 100,
            removeOnFail: 50,
          }
        );
      } catch (queueError) {
        // BullMQ/Redis unavailable — roll back reservation so credits aren't
        // permanently locked for a job that was never actually enqueued.
        try {
          const { releaseReservation } = await import("../services/creditSystem");
          await releaseReservation(userId, subscriptionId, reservationId, estimated);
        } catch (releaseError) {
          req.log.error({ err: releaseError }, "Failed to release reservation after queue failure");
        }
        throw queueError;
      }

      // Build breakdown for response
      const analysisCreditCost = Math.min(
        CREDIT_COSTS.ANALYSIS_MAX,
        Math.max(CREDIT_COSTS.ANALYSIS_MIN, CREDIT_COSTS.ANALYSIS_MIN + pageCount)
      );

      const breakdown: AnalysisCost["breakdown"] = [
        { action: "analysis", label: "Contract analysis", credits: analysisCreditCost },
      ];

      if (include_redlines) {
        const redlineCost = estimatedClauseCount * CREDIT_COSTS.REDLINE;
        breakdown.push({
          action: "redline",
          label: `Redline suggestions (~${estimatedClauseCount} clauses)`,
          credits: redlineCost,
        });
      }

      const response: AnalysisCost = {
        estimated_credits: estimated,
        actual_credits: 0, // filled after completion
        breakdown,
      };

      res.status(202).json({
        analysis_id: analysis.id,
        status: "queued",
        ...response,
      });
    } catch (error) {
      req.log.error({ err: error }, "Analysis error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* ── GET /analysis/:id ────────────────────────────── */

router.get(
  "/:id",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const analysisId = req.params.id as string;

      // Validate UUID format before hitting the DB — PostgreSQL throws a
      // cast error (→ 500) when given a malformed UUID, not a graceful miss.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(analysisId)) {
        res.status(404).json({ error: "Analysis not found" });
        return;
      }

      const [analysis] = await db
        .select()
        .from(schema.analyses)
        .where(
          and(
            eq(schema.analyses.id, analysisId),
            eq(schema.analyses.userId, userId)
          )
        )
        .limit(1);

      if (!analysis) {
        res.status(404).json({ error: "Analysis not found" });
        return;
      }

      // Get clauses if analysis is completed
      let clauseList: object[] = [];
      if (analysis.status === "completed") {
        const clauseRows = await db
          .select()
          .from(schema.clauses)
          .where(eq(schema.clauses.analysisId, analysisId))
          .orderBy(schema.clauses.clauseNumber);

        clauseList = clauseRows.map((c) => ({
          id: c.id,
          clause_number: c.clauseNumber,
          category: c.category,
          title: c.title,
          text: c.text,
          risk_level: c.riskLevel,
          score: c.score,
          explanation: c.explanation ?? null,
          suggested_rewrite: c.suggestedRewrite ?? null,
          policy_violations: (c.policyViolations ?? []).map((v) => ({
            explanation: v.explanation,
          })),
        }));
      }

      // Get contract info
      const [contract] = await db
        .select()
        .from(schema.contracts)
        .where(eq(schema.contracts.id, analysis.contractId))
        .limit(1);

      res.json({
        id: analysis.id,
        contract_id: analysis.contractId,
        contract_name: contract?.originalName || "Unknown",
        status: analysis.status,
        risk_score: analysis.riskScore,
        credits_estimated: analysis.creditsEstimated,
        credits_actual: analysis.creditsActual,
        include_redlines: analysis.includeRedlines,
        started_at: analysis.startedAt?.toISOString() || null,
        completed_at: analysis.completedAt?.toISOString() || null,
        error: analysis.error,
        clauses: clauseList,
      });
    } catch (error) {
      req.log.error({ err: error }, "Get analysis error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
