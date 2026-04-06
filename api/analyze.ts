/**
 * POST /api/analyze
 *
 * Creates an analysis job and enqueues it via Upstash QStash for guaranteed,
 * durable delivery. Always returns { analysis_id } immediately.
 *
 * In local/dev environments without QSTASH_TOKEN the job runs inline so
 * developers get a working experience without a queue.
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY (or OPENAI_API_KEY)
 *   QSTASH_TOKEN       — Upstash QStash publish token (required in production)
 *
 * Optional env vars:
 *   QSTASH_WORKER_URL  — Override worker URL (defaults to VERCEL_URL + /api/worker/analyze)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — persistent rate limiting
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getUserIdFromToken, getServiceClient } from "../lib/server/supabase";
import { checkRateLimit } from "../lib/server/rate-limit";
import { processAnalysis } from "../lib/server/process-analysis";
import { log, warn, err as logErr } from "../lib/server/logger";
import type { AnalysisJob } from "../lib/server/types";

const ESTIMATED_CREDITS = 10;
// QStash will retry the worker this many times on non-2xx before giving up.
const QSTASH_RETRIES = 3;

function estimatedBreakdown() {
  return [{ action: "analysis", label: "Contract analysis", credits: ESTIMATED_CREDITS }];
}

function resolveWorkerUrl(): string | null {
  if (process.env.QSTASH_WORKER_URL) return process.env.QSTASH_WORKER_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/api/worker/analyze`;
  return null;
}

async function enqueueViaQStash(job: AnalysisJob, workerUrl: string): Promise<void> {
  const { Client } = await import("@upstash/qstash");
  const client = new Client({ token: process.env.QSTASH_TOKEN! });
  await client.publishJSON({
    url: workerUrl,
    body: job as unknown as Record<string, unknown>,
    retries: QSTASH_RETRIES,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = (req.headers?.authorization as string) ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing authorization token" });

    let userId: string;
    try {
      userId = await getUserIdFromToken(token);
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // ── Rate limit ────────────────────────────────────────────────────────────
    const { allowed } = await checkRateLimit(userId);
    if (!allowed) {
      return res
        .status(429)
        .json({ error: "Too many requests. Please wait before analyzing again." });
    }

    // ── Input validation ──────────────────────────────────────────────────────
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contract_id = body.contract_id;
    const include_redlines = body.include_redlines === true;

    if (!contract_id || typeof contract_id !== "string") {
      return res.status(400).json({ error: "contract_id is required and must be a string" });
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(contract_id)) {
      return res.status(400).json({ error: "contract_id must be a valid UUID" });
    }

    // ── Verify contract ownership + validate file ─────────────────────────────
    const db = getServiceClient();
    const { data: contract, error: contractErr } = await db
      .from("contracts")
      .select("id, filename, file_size")
      .eq("id", contract_id)
      .eq("user_id", userId)
      .single();

    if (contractErr || !contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    const MAX_FILE_BYTES = 10 * 1024 * 1024;
    const fileSize = (contract.file_size as number | null) ?? 0;
    if (fileSize > MAX_FILE_BYTES) {
      return res.status(413).json({
        error: `File too large (${(fileSize / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 10 MB.`,
      });
    }

    const ALLOWED_EXTENSIONS = new Set(["pdf", "docx", "txt", "jpg", "jpeg", "png"]);
    const ext = String(contract.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(422).json({
        error: `Unsupported file type ".${ext}". Allowed: PDF, DOCX, TXT, JPG, PNG.`,
      });
    }

    // ── Create analysis record ────────────────────────────────────────────────
    const { data: analysisRow, error: insertErr } = await db
      .from("analyses")
      .insert({
        contract_id,
        user_id: userId,
        status: "queued",
        include_redlines,
        credits_estimated: ESTIMATED_CREDITS,
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (insertErr || !analysisRow) {
      logErr("analyze", "Analysis record insert failed", { error: insertErr?.message });
      return res.status(500).json({ error: "Could not create analysis record. Please try again." });
    }

    const analysis_id = analysisRow.id as string;

    await db
      .from("contracts")
      .update({ latest_analysis_id: analysis_id, latest_analysis_status: "queued" })
      .eq("id", contract_id);

    const job: AnalysisJob = { analysis_id, contract_id, user_id: userId, include_redlines };

    // ── Enqueue via QStash (production) or run inline (dev) ───────────────────
    if (process.env.QSTASH_TOKEN) {
      const workerUrl = resolveWorkerUrl();

      if (!workerUrl) {
        // QStash token present but no URL — misconfigured; fail loudly
        logErr("analyze", "QSTASH_TOKEN is set but worker URL cannot be resolved. Set QSTASH_WORKER_URL or VERCEL_URL.", { analysis_id });
        await Promise.all([
          db.from("analyses").update({ status: "failed", error: "Queue configuration error." }).eq("id", analysis_id),
          db.from("contracts").update({ latest_analysis_status: "failed" }).eq("id", contract_id),
        ]);
        return res.status(500).json({ error: "Queue configuration error. Please contact support." });
      }

      try {
        await enqueueViaQStash(job, workerUrl);
        log("analyze", "Job enqueued", { analysis_id, workerUrl });
      } catch (qErr) {
        const qErrMsg = qErr instanceof Error ? qErr.message : String(qErr);
        logErr("analyze", "QStash enqueue failed", { analysis_id, error: qErrMsg });
        await Promise.all([
          db.from("analyses").update({ status: "failed", error: "Failed to queue analysis. Please try again." }).eq("id", analysis_id),
          db.from("contracts").update({ latest_analysis_status: "failed" }).eq("id", contract_id),
        ]);
        return res.status(500).json({ error: "Failed to queue analysis. Please try again." });
      }
    } else {
      // Dev / local mode only — run inline so devs don't need QStash configured
      warn("analyze", "QSTASH_TOKEN not configured — running analysis inline (dev mode only, not for production)", { analysis_id });
      await processAnalysis(job);
    }

    return res.status(200).json({
      analysis_id,
      status: "queued",
      estimated_credits: ESTIMATED_CREDITS,
      actual_credits: 0,
      breakdown: estimatedBreakdown(),
    });
  } catch (err: unknown) {
    logErr("analyze", "FATAL unhandled error", { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "An unexpected error occurred. Please try again." });
  }
}
