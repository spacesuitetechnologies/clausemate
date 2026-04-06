/**
 * Core analysis processing pipeline.
 * Used by both the QStash worker and the inline fallback.
 *
 * Deduplication layers (in order):
 *   1. File hash  — same raw bytes → skip OCR + LLM entirely
 *   2. Text hash  — same extracted text (different upload) → skip LLM
 *
 * Required Supabase tables:
 *
 *   ALTER TABLE analyses
 *     ADD COLUMN IF NOT EXISTS status           text    DEFAULT 'completed',
 *     ADD COLUMN IF NOT EXISTS full_result      jsonb,
 *     ADD COLUMN IF NOT EXISTS error            text,
 *     ADD COLUMN IF NOT EXISTS include_redlines boolean DEFAULT false,
 *     ADD COLUMN IF NOT EXISTS tokens_input     integer,
 *     ADD COLUMN IF NOT EXISTS tokens_output    integer,
 *     ADD COLUMN IF NOT EXISTS cost_usd         numeric(10,6),
 *     ADD COLUMN IF NOT EXISTS provider         text;
 *
 *   CREATE TABLE IF NOT EXISTS analysis_result_cache (
 *     cache_key   text PRIMARY KEY,   -- file hash OR text hash
 *     full_result jsonb NOT NULL,
 *     risk_score  integer,
 *     created_at  timestamptz DEFAULT now()
 *   );
 */

import { createHash } from "node:crypto";
import { getServiceClient } from "./supabase";
import { extractContractText, ExtractionError } from "./extract-text";
import { analyzeWithLLM } from "./llm";
import { mergeWithPolicyRisks } from "./policy";
import { log, warn, err as logErr } from "./logger";
import type { AnalysisJob, AnalyzeContractResult, LLMUsage } from "./types";

const MAX_JOB_RETRIES = 2;
const RETRY_BACKOFF_MS = [3_000, 6_000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function getResultCache(cacheKey: string): Promise<AnalyzeContractResult | null> {
  try {
    const { data, error } = await getServiceClient()
      .from("analysis_result_cache")
      .select("full_result")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (error || !data?.full_result) return null;
    return data.full_result as AnalyzeContractResult;
  } catch {
    return null;
  }
}

async function setResultCache(cacheKey: string, result: AnalyzeContractResult): Promise<void> {
  try {
    await getServiceClient()
      .from("analysis_result_cache")
      .upsert(
        {
          cache_key: cacheKey,
          full_result: result as unknown as Record<string, unknown>,
          risk_score: result.risk_score,
        },
        { onConflict: "cache_key" },
      );
  } catch {
    // Non-fatal — table may not exist
  }
}

// ── Timeout helper ────────────────────────────────────────────────────────────

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /timeout|aborted/i.test(err.message));
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function processAnalysis(job: AnalysisJob): Promise<void> {
  const { analysis_id, contract_id, user_id } = job;
  const externalRetryCount = job.retry_count ?? 0;
  const db = getServiceClient();
  const startMs = Date.now();

  log("process", "Analysis starting", { analysis_id, contract_id, retryCount: externalRetryCount });

  // Mark as processing
  await db
    .from("analyses")
    .update({ status: "processing" })
    .eq("id", analysis_id)
    .eq("user_id", user_id);

  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_JOB_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BACKOFF_MS[attempt - 1] ?? 6_000;
      warn("process", `Retrying analysis (attempt ${attempt + 1}/${MAX_JOB_RETRIES + 1})`, {
        analysis_id,
        delay,
        prevError: lastErr instanceof Error ? lastErr.message : String(lastErr),
      });
      await sleep(delay);
    }

    try {
      // ── Fetch contract metadata ───────────────────────────────────────────
      const { data: contract, error: contractErr } = await db
        .from("contracts")
        .select("file_url, filename")
        .eq("id", contract_id)
        .eq("user_id", user_id)
        .single();

      if (contractErr || !contract) {
        throw new ExtractionError("Contract not found");
      }

      // ── Extract text ──────────────────────────────────────────────────────
      const extracted = await extractContractText(contract_id, contract.file_url, contract.filename);

      log("process", "Text extracted", {
        analysis_id,
        charCount: extracted.trimmedText.length,
        fromCache: extracted.fromCache,
        ocrUsed: extracted.ocrUsed,
        wasTrimmed: extracted.wasTrimmed,
        fileHash: extracted.fileHash.slice(0, 8),
        attempt,
      });

      // ── Deduplication: file hash first, then text hash ────────────────────
      const fileHashKey = `file:${extracted.fileHash}`;
      const textHashKey = `text:${textHash(extracted.trimmedText)}`;

      let cachedResult = await getResultCache(fileHashKey);
      let cacheHit = false;

      if (cachedResult) {
        log("process", "Cache hit (file hash)", { analysis_id, cacheKey: fileHashKey.slice(0, 16) });
        cacheHit = true;
      } else {
        cachedResult = await getResultCache(textHashKey);
        if (cachedResult) {
          log("process", "Cache hit (text hash)", { analysis_id, cacheKey: textHashKey.slice(0, 16) });
          cacheHit = true;
          // Also promote to file-hash key so future identical uploads hit faster
          setResultCache(fileHashKey, cachedResult).catch(() => {});
        }
      }

      let result: AnalyzeContractResult;
      let usage: LLMUsage | null = null;

      if (cachedResult) {
        result = {
          ...cachedResult,
          contract_text: extracted.trimmedText,
          was_trimmed: extracted.wasTrimmed,
        };
      } else {
        // ── LLM Analysis ────────────────────────────────────────────────────
        log("process", "Running LLM analysis", { analysis_id, attempt });

        const { result: llmResult, usage: llmUsage } = await analyzeWithLLM(extracted.trimmedText);
        const llm = mergeWithPolicyRisks(llmResult);
        usage = llmUsage;

        result = {
          summary: llm.summary,
          risks: llm.risks,
          clauses: llm.clauses,
          risk_score: llm.risk_score,
          missing_clauses: llm.missing_clauses,
          suggestions: llm.suggestions,
          parties: llm.parties,
          effective_date: llm.effective_date,
          jurisdiction: llm.jurisdiction,
          structured_risks: llm.structured_risks,
          structured_clauses: llm.structured_clauses,
          contract_text: extracted.trimmedText,
          was_trimmed: extracted.wasTrimmed,
        };

        // Cache by both keys in background
        setResultCache(fileHashKey, result).catch(() => {});
        setResultCache(textHashKey, result).catch(() => {});
      }

      // ── Persist result ────────────────────────────────────────────────────
      const analysisUpdate: Record<string, unknown> = {
        status: "completed",
        full_result: result as unknown as Record<string, unknown>,
        risk_score: result.risk_score,
        summary: result.summary,
        risks: JSON.stringify(result.risks),
        clauses: JSON.stringify(result.clauses),
        error: null,
      };

      if (usage) {
        analysisUpdate.tokens_input  = usage.input_tokens;
        analysisUpdate.tokens_output = usage.output_tokens;
        analysisUpdate.cost_usd      = usage.cost_usd;
        analysisUpdate.provider      = usage.provider;
      }

      await Promise.all([
        db.from("analyses").update(analysisUpdate).eq("id", analysis_id),
        db.from("contracts").update({
          latest_analysis_id: analysis_id,
          latest_analysis_status: "completed",
          risk_score: result.risk_score,
          clause_count: result.clauses.length,
        }).eq("id", contract_id),
      ]);

      const durationMs = Date.now() - startMs;
      log("process", "Analysis completed", {
        analysis_id,
        durationMs,
        risk_score: result.risk_score,
        clauseCount: result.clauses.length,
        cacheHit,
        attempt,
        provider: usage?.provider ?? "cached",
        cost_usd: usage?.cost_usd ?? 0,
        tokens: usage ? (usage.input_tokens + usage.output_tokens) : 0,
      });

      return; // success — exit retry loop

    } catch (err: unknown) {
      lastErr = err;

      // ExtractionErrors and timeouts are not retryable
      const isNonRetryable = err instanceof ExtractionError || isTimeoutError(err);
      if (isNonRetryable) {
        warn("process", "Non-retryable error — skipping retries", {
          analysis_id,
          error: err instanceof Error ? err.message : String(err),
          isTimeout: isTimeoutError(err),
        });
        break;
      }

      if (attempt < MAX_JOB_RETRIES) {
        warn("process", `Analysis attempt ${attempt + 1} failed — will retry`, {
          analysis_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── All attempts exhausted — mark failed ─────────────────────────────────
  const durationMs = Date.now() - startMs;
  const errorMessage = lastErr instanceof Error ? lastErr.message : "An unexpected error occurred.";
  const isUserFacing = lastErr instanceof ExtractionError;
  const isTimeout = isTimeoutError(lastErr);

  const publicMessage = isTimeout
    ? "Analysis timed out. Please try again with a shorter document."
    : isUserFacing
      ? errorMessage
      : "Analysis failed. Please try again.";

  logErr("process", "Analysis failed", {
    analysis_id,
    durationMs,
    error: errorMessage,
    isTimeout,
    isUserFacing,
    attemptsTotal: MAX_JOB_RETRIES + 1,
  });

  await Promise.all([
    db.from("analyses").update({ status: "failed", error: publicMessage }).eq("id", analysis_id),
    db.from("contracts").update({ latest_analysis_status: "failed" }).eq("id", contract_id),
  ]);
}
