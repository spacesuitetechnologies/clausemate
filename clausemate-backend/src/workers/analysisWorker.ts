import { Worker, type Job } from "bullmq";
import { eq, and } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { logger } from "../services/logger";
import { getRedisConnectionOpts, type AnalysisJobData } from "./queue";
import { getStorage, extractTextFromBuffer, getPageCount } from "../services/storage";
import { extractAndNormalizeClauses } from "../services/clauseExtractor";
import { evaluateAllClauses } from "../services/policyEngine";
import { computeRiskScore, type ClauseRiskInput } from "../services/riskScoring";
import { generateExplanation, generateRedline } from "../services/llm";
import { finalizeCredits, releaseReservation } from "../services/creditSystem";
import { checkContractSize, calcLlmCostUsd, accumulateTokens } from "../services/llmCostGuard";
import { CREDIT_COSTS } from "../types";
import { config } from "../config";

/* ── Step Tracking ────────────────────────────────── */

const STEPS = [
  "fetch_contract",
  "extract_text",
  "extract_clauses",
  "validate_clauses",
  "evaluate_policies",
  "compute_risk_scores",
  "generate_explanations",
  "generate_redlines",
  "save_results",
  "finalize",
] as const;

type Step = (typeof STEPS)[number];

async function updateAnalysisStatus(
  analysisId: string,
  status: "processing" | "completed" | "failed",
  extra: Record<string, unknown> = {}
): Promise<void> {
  await db
    .update(schema.analyses)
    .set({ status, ...extra })
    .where(eq(schema.analyses.id, analysisId));
}

/* ── 10-Step Analysis Pipeline ────────────────────── */

async function processAnalysis(job: Job<AnalysisJobData>): Promise<void> {
  const {
    analysisId,
    contractId,
    userId,
    storagePath,
    mimeType,
    includeRedlines,
    pageCount,
    creditsEstimated,
    subscriptionId,
    reservationId,
  } = job.data;
  let currentStep: Step = "fetch_contract";

  // Accumulated LLM token usage across all calls in this analysis.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // BullMQ retry context — surfaced in every log line so each attempt is
  // distinguishable without cross-referencing job IDs in the queue.
  const maxAttempts = (job.opts?.attempts ?? 1) as number;
  const attemptNumber = job.attemptsMade + 1;

  // Guards the catch block from overwriting a "completed" status.
  // Once finalizeCredits succeeds the analysis is complete from a billing
  // perspective — any subsequent DB error must not roll back to "failed"
  // and trigger a BullMQ retry (which would double-charge credits).
  let creditsFinalised = false;

  try {
    // ─── Step 1: Mark as processing ─────────────────
    logger.info(
      { analysisId, contractId, userId, attempt: attemptNumber, maxAttempts },
      "analysis.started"
    );
    await updateAnalysisStatus(analysisId, "processing", {
      startedAt: new Date(),
      // Clear any error message written by a previous failed attempt so the
      // DB row doesn't show a stale error while the retry is in flight.
      error: null,
    });
    await job.updateProgress(10);

    // ─── Step 2: Fetch contract from storage ────────
    currentStep = "fetch_contract";
    const storage = getStorage();
    const fileBuffer = await storage.read(storagePath);
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new Error("Contract file is empty or missing");
    }
    await job.updateProgress(15);

    // ─── Step 3: Extract text ───────────────────────
    currentStep = "extract_text";
    const contractText = await extractTextFromBuffer(fileBuffer, mimeType);
    if (!contractText || contractText.trim().length === 0) {
      throw new Error("Could not extract text from contract");
    }

    // Guard against contracts that would exceed the LLM input-token ceiling.
    // This is a cheap character-count check — avoids a costly API call that
    // would be rejected (and billed) by the provider anyway.
    const sizeCheck = checkContractSize(contractText);
    if (!sizeCheck.ok) {
      throw new Error(
        `Contract is too large for analysis (~${sizeCheck.estimatedTokens.toLocaleString()} estimated tokens, ` +
        `limit is ${config.llm.maxInputTokens.toLocaleString()}). ` +
        `Please upload a shorter document.`
      );
    }

    await job.updateProgress(25);

    // ─── Step 4: LLM clause extraction ──────────────
    currentStep = "extract_clauses";
    const {
      clauses: rawClauses,
      inputTokens: extractIn,
      outputTokens: extractOut,
    } = await extractAndNormalizeClauses(contractText);
    totalInputTokens += extractIn;
    totalOutputTokens += extractOut;
    if (rawClauses.length === 0) {
      throw new Error("No clauses could be extracted from the contract");
    }
    await job.updateProgress(40);

    // ─── Step 5: Validate/normalize clauses ─────────
    currentStep = "validate_clauses";
    const validClauses = rawClauses.filter(
      (c) => c.text.length > 10 && c.title.length > 0
    );
    if (validClauses.length === 0) {
      throw new Error("No valid clauses found after filtering");
    }
    await job.updateProgress(45);

    // ─── Step 6: Run policy engine ──────────────────
    currentStep = "evaluate_policies";
    const policyResults = await evaluateAllClauses(validClauses);
    await job.updateProgress(55);

    // ─── Step 7: Compute risk scores ────────────────
    currentStep = "compute_risk_scores";
    const clauseRiskInputs: ClauseRiskInput[] = validClauses.map((clause) => {
      const policyResult = policyResults.get(clause.clause_number);
      return {
        clauseNumber: clause.clause_number,
        category: clause.category,
        riskLevel: policyResult?.highestRiskLevel || "low",
        policyViolations: policyResult?.violations || [],
      };
    });
    const riskScoreResult = computeRiskScore(clauseRiskInputs);
    await job.updateProgress(60);

    // ─── Step 8: Generate explanations (LLM) ────────
    currentStep = "generate_explanations";
    const explanations = new Map<number, string>();
    for (const clause of validClauses) {
      const policyResult = policyResults.get(clause.clause_number);
      const riskLevel = policyResult?.highestRiskLevel || "low";

      // Only generate detailed explanations for medium+ risk
      if (riskLevel !== "low") {
        const violationTexts =
          policyResult?.violations.map((v) => v.explanation) || [];
        const { text: explanation, inputTokens: exIn, outputTokens: exOut } =
          await generateExplanation(clause.text, riskLevel, violationTexts);
        totalInputTokens += exIn;
        totalOutputTokens += exOut;
        explanations.set(clause.clause_number, explanation);
      } else {
        explanations.set(
          clause.clause_number,
          "This clause appears to have standard, balanced terms with no significant risk indicators."
        );
      }
    }
    await job.updateProgress(75);

    // ─── Step 9: Generate redlines if requested ─────
    currentStep = "generate_redlines";
    const redlines = new Map<number, string>();
    if (includeRedlines) {
      for (const clause of validClauses) {
        const policyResult = policyResults.get(clause.clause_number);
        const riskLevel = policyResult?.highestRiskLevel || "low";

        // Only generate redlines for medium+ risk
        if (riskLevel !== "low") {
          const explanation = explanations.get(clause.clause_number) || "";
          const { text: redline, inputTokens: rdIn, outputTokens: rdOut } =
            await generateRedline(clause.text, riskLevel, explanation);
          totalInputTokens += rdIn;
          totalOutputTokens += rdOut;
          redlines.set(clause.clause_number, redline);
        }
      }
    }
    await job.updateProgress(85);

    // ─── Step 10: Save all results to DB ────────────
    currentStep = "save_results";

    // Delete any clauses written by a previous attempt before inserting.
    // On retry, the worker would otherwise duplicate every clause row.
    // The DB UNIQUE constraint on (analysis_id, clause_number) is the
    // safety net, but doing the delete first gives a clean slate and
    // avoids a confusing unique-violation error on retry.
    await db
      .delete(schema.clauses)
      .where(eq(schema.clauses.analysisId, analysisId));

    // Batch-insert all clauses in a single round-trip.
    await db.insert(schema.clauses).values(
      validClauses.map((clause) => {
        const policyResult = policyResults.get(clause.clause_number);
        const riskLevel = policyResult?.highestRiskLevel || "low";
        return {
          analysisId,
          clauseNumber: clause.clause_number,
          category: clause.category,
          title: clause.title,
          text: clause.text,
          riskLevel,
          score: riskScoreResult.normalizedClauseScores.get(clause.clause_number) ?? 0,
          explanation: explanations.get(clause.clause_number) || null,
          suggestedRewrite: redlines.get(clause.clause_number) || null,
          policyViolations: policyResult?.violations || [],
        };
      })
    );
    await job.updateProgress(90);

    // ─── Step 11: Finalize — convert reservation to spend
    currentStep = "finalize";
    const actualCredits = computeActualCredits(
      pageCount,
      includeRedlines,
      validClauses.length,
      redlines.size
    );

    // Compute the USD cost of all LLM calls in this analysis.
    // Uses the primary provider's model name; if the fallback fired it's
    // a slight overcount but acceptable as a conservative billing estimate.
    const primaryModel = config.llm.primaryProvider === "openai"
      ? config.llm.modelOpenai
      : config.llm.modelAnthropic;
    const llmCostUsd = calcLlmCostUsd(totalInputTokens, totalOutputTokens, primaryModel);

    // Convert the reservation made at queue time to actual spend.
    // reservedAmount may differ from actualCredits (estimate vs reality).
    const finalizeResult = await finalizeCredits(userId, subscriptionId, reservationId, creditsEstimated, actualCredits);

    // "already consumed or released" means a previous attempt successfully
    // finalized but the process crashed before creditsFinalised was set.
    // The reservation is already consumed — treat this attempt as if finalize
    // succeeded so we continue to mark the analysis completed, not failed.
    // Any other failure is a real problem and should retry.
    const alreadyConsumed =
      !finalizeResult.success &&
      (finalizeResult.error ?? "").includes("already consumed or released");

    if (!finalizeResult.success && !alreadyConsumed) {
      throw new Error(`Credit finalization failed: ${finalizeResult.error}`);
    }

    if (alreadyConsumed) {
      logger.warn(
        { analysisId, userId, reservationId },
        "analysis.finalize_already_consumed — previous attempt charged credits; continuing to completed"
      );
    }

    // Credits are now consumed. Any error from here on must NOT trigger
    // a BullMQ retry (which would re-run the job and double-charge).
    // The creditsFinalised flag tells the catch block to absorb the error,
    // attempt a best-effort status update, and return without re-throwing.
    creditsFinalised = true;

    // Persist LLM cost data and accumulate monthly token usage.
    await updateAnalysisStatus(analysisId, "completed", {
      riskScore: riskScoreResult.overallScore,
      creditsActual: actualCredits,
      llmInputTokens: totalInputTokens,
      llmOutputTokens: totalOutputTokens,
      llmCostUsd: llmCostUsd.toFixed(6),
      completedAt: new Date(),
    });

    await accumulateTokens(subscriptionId, totalInputTokens + totalOutputTokens);

    // Update contract status
    await db
      .update(schema.contracts)
      .set({ status: "ready" })
      .where(eq(schema.contracts.id, contractId));

    await job.updateProgress(100);
    logger.info(
      {
        analysisId, userId,
        riskScore: riskScoreResult.overallScore,
        clauses: validClauses.length,
        creditsActual: actualCredits,
        llmInputTokens: totalInputTokens,
        llmOutputTokens: totalOutputTokens,
        llmCostUsd: llmCostUsd.toFixed(6),
      },
      "analysis.completed"
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    // Credits were already consumed (finalizeCredits succeeded).
    // A post-finalize error (accumulateTokens, status update, contract update)
    // must NOT overwrite "completed" with "failed" or trigger a BullMQ retry —
    // that would double-charge the user on the retry attempt.
    // Best-effort: try to mark the analysis completed so the user can see results.
    // The credits are spent regardless.
    if (creditsFinalised) {
      logger.error(
        { analysisId, userId, step: currentStep, err: errorMessage },
        "analysis.post_finalize_error — credits already consumed, suppressing retry"
      );
      try {
        await updateAnalysisStatus(analysisId, "completed", { completedAt: new Date() });
      } catch (statusErr) {
        logger.error({ analysisId, err: statusErr }, "analysis.status_update_failed_post_finalize");
      }
      // Return WITHOUT re-throwing — BullMQ sees success, no retry.
      return;
    }

    const isLastAttempt = attemptNumber >= maxAttempts;

    if (isLastAttempt) {
      // Final attempt failed — the job will not be retried by BullMQ.
      logger.error(
        { analysisId, userId, step: currentStep, attempt: attemptNumber, maxAttempts, err: errorMessage },
        "analysis.failed"
      );

      // Release the credit reservation so the user can try submitting again.
      // We hold the reservation across earlier retries so a concurrent
      // submission cannot race against the in-flight retry and overdraw the
      // balance. Only release here, on the conclusive last attempt.
      try {
        await releaseReservation(userId, subscriptionId, reservationId, creditsEstimated);
        logger.info({ analysisId, userId, credits: creditsEstimated }, "credits.released");
      } catch (releaseError) {
        logger.error({ analysisId, userId, err: releaseError }, "credits.release_failed");
      }
    } else {
      // Non-final failure — BullMQ will schedule another attempt.
      // Keep the reservation locked: releasing it here then re-locking on
      // the next attempt would create a race window.
      logger.warn(
        { analysisId, userId, step: currentStep, attempt: attemptNumber, maxAttempts, err: errorMessage },
        "analysis.retrying"
      );
    }

    await updateAnalysisStatus(analysisId, "failed", {
      error: `Failed at step "${currentStep}" (attempt ${attemptNumber}/${maxAttempts}): ${errorMessage}`,
      completedAt: new Date(),
    });

    throw error; // re-throw so BullMQ records the failure and schedules a retry
  }
}

/* ── Credit Calculation ───────────────────────────── */

function computeActualCredits(
  pageCount: number,
  includeRedlines: boolean,
  clauseCount: number,
  redlineCount: number
): number {
  const analysisCost = Math.min(
    CREDIT_COSTS.ANALYSIS_MAX,
    Math.max(CREDIT_COSTS.ANALYSIS_MIN, CREDIT_COSTS.ANALYSIS_MIN + pageCount)
  );

  let total = analysisCost;

  if (includeRedlines && redlineCount > 0) {
    total += redlineCount * CREDIT_COSTS.REDLINE;
  }

  return total;
}

/* ── Worker Startup ───────────────────────────────── */

let worker: Worker | null = null;

export function startAnalysisWorker(): Worker {
  if (worker) return worker;

  worker = new Worker<AnalysisJobData>(
    "contract-analysis",
    async (job) => {
      const { analysisId, userId, subscriptionId, reservationId, creditsEstimated } = job.data;
      const maxAttempts = (job.opts?.attempts ?? 1) as number;
      const attemptNumber = job.attemptsMade + 1;
      const isLastAttempt = attemptNumber >= maxAttempts;

      // Race the analysis against a hard wall-clock timeout.
      // If the timeout fires first we release credits (on final attempt),
      // mark the job failed, and re-throw so BullMQ records the outcome.
      // The dangling processAnalysis promise is suppressed with .catch(()=>{})
      // — the idempotent credit state machine makes any late release safe.
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`JOB_TIMEOUT: analysis exceeded ${config.analysis.jobTimeoutMs}ms`));
        }, config.analysis.jobTimeoutMs);
      });

      try {
        await Promise.race([processAnalysis(job), timeoutPromise]);
      } catch (error) {
        const isTimeout =
          error instanceof Error && error.message.startsWith("JOB_TIMEOUT:");

        if (isTimeout) {
          if (isLastAttempt) {
            logger.error(
              { analysisId, userId, attempt: attemptNumber, maxAttempts, timeoutMs: config.analysis.jobTimeoutMs },
              "job.timeout"
            );
            try {
              await releaseReservation(userId, subscriptionId, reservationId, creditsEstimated);
              logger.info({ analysisId, userId, credits: creditsEstimated }, "credits.released");
            } catch (releaseError) {
              logger.error({ analysisId, userId, err: releaseError }, "credits.release_failed");
            }
            await updateAnalysisStatus(analysisId, "failed", {
              error: `Analysis timed out after ${config.analysis.jobTimeoutMs}ms (attempt ${attemptNumber}/${maxAttempts})`,
              completedAt: new Date(),
            });
          } else {
            logger.warn(
              { analysisId, userId, attempt: attemptNumber, maxAttempts, timeoutMs: config.analysis.jobTimeoutMs },
              "job.timeout_will_retry"
            );
            await updateAnalysisStatus(analysisId, "failed", {
              error: `Analysis timed out (attempt ${attemptNumber}/${maxAttempts}), retrying…`,
              completedAt: new Date(),
            });
          }
        }

        // Suppress the dangling processAnalysis rejection so Node doesn't
        // emit an unhandledRejection after the race already resolved.
        timeoutPromise.catch(() => {});

        throw error; // re-throw so BullMQ records the failure / schedules retry
      } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      }
    },
    {
      connection: getRedisConnectionOpts(),
      // How many jobs run in parallel in this worker process.
      concurrency: config.analysis.workerConcurrency,
      // LLM call rate ceiling: at most workerLimiterMax jobs started
      // within workerLimiterWindowMs, across ALL worker processes.
      // This is the primary protection for LLM API quota/cost.
      limiter: {
        max: config.analysis.workerLimiterMax,
        duration: config.analysis.workerLimiterWindowMs,
      },
      // Distributed lock lease duration.  The heartbeat fires at
      // lockDuration/2, so a 5-minute lease means a heartbeat every 2.5 min.
      // If the process dies without renewing, the job returns to waiting after
      // ~lockDuration.
      lockDuration: config.analysis.workerLockDurationMs,
      // How often BullMQ scans across all workers for stalled jobs.
      stalledInterval: config.analysis.workerStalledIntervalMs,
      // Max times a job may stall before being permanently failed.
      maxStalledCount: config.analysis.workerMaxStalledCount,
    }
  );

  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id, analysisId: job.data.analysisId }, "job.completed");
  });

  worker.on("failed", (job, err) => {
    logger.warn({ jobId: job?.id, analysisId: job?.data.analysisId, err: err.message }, "job.failed");
  });

  worker.on("error", (err) => {
    logger.error({ err }, "worker.error");
  });

  // Emitted when BullMQ detects a stalled job (lock expired without renewal).
  // This typically means the worker process was paused (GC, OOM, host sleep).
  // BullMQ will retry or permanently fail the job per maxStalledCount.
  worker.on("stalled", (jobId: string) => {
    logger.warn({ jobId }, "job.stalled");
  });

  logger.info("Analysis worker started");
  return worker;
}

export async function stopAnalysisWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("Analysis worker stopped");
  }
}
