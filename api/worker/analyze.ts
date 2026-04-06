/**
 * POST /api/worker/analyze
 *
 * Triggered by Upstash QStash after /api/analyze enqueues a job.
 * Verifies the QStash signature, enforces idempotency, then runs the
 * full analysis pipeline.
 *
 * Idempotency:
 *   - Returns 200 immediately if the job is already completed or failed.
 *   - Re-runs if status is still "processing" (previous worker crashed).
 *
 * QStash retries:
 *   - Worker returns 5xx only on unexpected errors so QStash will re-deliver.
 *   - processAnalysis handles its own LLM-level retries internally and always
 *     marks the job completed/failed before returning — so the normal 200 path
 *     does not trigger QStash retries.
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY (or OPENAI_API_KEY)
 *
 * Optional env vars:
 *   QSTASH_CURRENT_SIGNING_KEY  — QStash signature verification
 *   QSTASH_NEXT_SIGNING_KEY     — QStash signature verification
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getServiceClient } from "../../lib/server/supabase";
import { processAnalysis } from "../../lib/server/process-analysis";
import { log, warn, err as logErr } from "../../lib/server/logger";
import type { AnalysisJob } from "../../lib/server/types";

async function verifyQStashSignature(req: VercelRequest): Promise<boolean> {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  // No signing keys configured — skip verification (local dev / self-hosted)
  if (!currentKey || !nextKey) return true;

  const signature = req.headers["upstash-signature"] as string | undefined;
  if (!signature) return false;

  try {
    const { Receiver } = await import("@upstash/qstash");
    const receiver = new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    await receiver.verify({ signature, body });
    return true;
  } catch (err) {
    logErr("worker", "QStash signature verification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ── Signature verification ──────────────────────────────────────────────────
  const isValid = await verifyQStashSignature(req);
  if (!isValid) {
    return res.status(401).json({ error: "Invalid QStash signature" });
  }

  // ── Parse job payload ───────────────────────────────────────────────────────
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { analysis_id, contract_id, user_id, include_redlines, retry_count } = body;

  if (
    !analysis_id || typeof analysis_id !== "string" ||
    !contract_id || typeof contract_id !== "string" ||
    !user_id || typeof user_id !== "string"
  ) {
    // Return 400 (not 5xx) so QStash does not infinitely retry an unprocessable payload
    logErr("worker", "Invalid job payload received", {
      analysis_id: analysis_id ?? "(missing)",
      contract_id: contract_id ?? "(missing)",
    });
    return res.status(400).json({ error: "Invalid job payload" });
  }

  // QStash sends the current delivery attempt count in this header (0-indexed)
  const qstashAttempt = parseInt(String(req.headers["upstash-retry-count"] ?? "0"), 10);

  log("worker", "Job received", { analysis_id, contract_id, qstashAttempt });

  // ── Idempotency check ───────────────────────────────────────────────────────
  // Protects against duplicate QStash deliveries (at-least-once semantics).
  const db = getServiceClient();
  const { data: existing } = await db
    .from("analyses")
    .select("status")
    .eq("id", analysis_id)
    .maybeSingle();

  if (existing?.status === "completed") {
    log("worker", "Job already completed — skipping duplicate delivery", { analysis_id, qstashAttempt });
    return res.status(200).json({ ok: true, skipped: true, reason: "already_completed", analysis_id });
  }

  if (existing?.status === "failed") {
    log("worker", "Job already failed — skipping duplicate delivery", { analysis_id, qstashAttempt });
    return res.status(200).json({ ok: true, skipped: true, reason: "already_failed", analysis_id });
  }

  if (existing?.status === "processing") {
    // Previous worker execution was killed before completing — re-run is correct.
    warn("worker", "Job found in processing state — previous worker may have crashed, re-running", {
      analysis_id,
      qstashAttempt,
    });
  }

  const job: AnalysisJob = {
    analysis_id,
    contract_id,
    user_id,
    include_redlines: include_redlines === true,
    // Prefer QStash attempt header over payload field as source of truth
    retry_count: qstashAttempt > 0 ? qstashAttempt : (typeof retry_count === "number" ? retry_count : 0),
  };

  // ── Process ─────────────────────────────────────────────────────────────────
  try {
    log("worker", "Job started", { analysis_id, qstashAttempt });
    await processAnalysis(job);
    log("worker", "Job completed", { analysis_id, qstashAttempt });
    return res.status(200).json({ ok: true, analysis_id });
  } catch (err: unknown) {
    // processAnalysis catches all expected failures internally.
    // This branch signals a truly unexpected crash — return 5xx so QStash retries.
    logErr("worker", "Unhandled error — QStash will retry", {
      analysis_id,
      qstashAttempt,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ error: "Worker encountered an unexpected error" });
  }
}
