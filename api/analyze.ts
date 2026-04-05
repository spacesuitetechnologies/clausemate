/**
 * POST /api/analyze
 *
 * Creates an analysis job, enqueues it via Upstash QStash (if configured),
 * or runs it inline as a synchronous fallback. Always returns immediately
 * with { analysis_id }.
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY (or OPENAI_API_KEY)
 *
 * Optional env vars (for async processing):
 *   QSTASH_TOKEN           — Upstash QStash publish token
 *   QSTASH_WORKER_URL      — Override worker URL (defaults to VERCEL_URL + /api/worker/analyze)
 *
 * Optional env vars (for persistent rate limiting):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getUserIdFromToken, getServiceClient } from "../lib/server/supabase";
import { checkRateLimit } from "../lib/server/rate-limit";
import { processAnalysis } from "../lib/server/process-analysis";

const ESTIMATED_CREDITS = 10;

function estimatedBreakdown() {
  return [{ action: "analysis", label: "Contract analysis", credits: ESTIMATED_CREDITS }];
}

async function enqueueViaQStash(
  payload: Record<string, unknown>,
  workerUrl: string,
): Promise<void> {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error("QSTASH_TOKEN not set");

  const { Client } = await import("@upstash/qstash");
  const client = new Client({ token });
  await client.publishJSON({ url: workerUrl, body: payload });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // ── Auth ────────────────────────────────────────────────────────────────
    const authHeader = (req.headers?.authorization as string) ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing authorization token" });

    let userId: string;
    try {
      userId = await getUserIdFromToken(token);
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // ── Rate limit ──────────────────────────────────────────────────────────
    const { allowed } = await checkRateLimit(userId);
    if (!allowed) {
      return res
        .status(429)
        .json({ error: "Too many requests. Please wait before analyzing again." });
    }

    // ── Input validation ────────────────────────────────────────────────────
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contract_id = body.contract_id;
    const include_redlines = body.include_redlines === true;

    if (!contract_id || typeof contract_id !== "string") {
      return res.status(400).json({ error: "contract_id is required and must be a string" });
    }

    // ── Verify contract ownership ───────────────────────────────────────────
    const db = getServiceClient();
    const { data: contract, error: contractErr } = await db
      .from("contracts")
      .select("id, filename")
      .eq("id", contract_id)
      .eq("user_id", userId)
      .single();

    if (contractErr || !contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    // ── Create analysis record (status: queued) ─────────────────────────────
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
      console.error("[analyze] Insert failed:", insertErr?.message);
      return res.status(500).json({ error: "Could not create analysis record. Please try again." });
    }

    const analysis_id = analysisRow.id as string;

    // Mark contract as queued
    await db
      .from("contracts")
      .update({ latest_analysis_id: analysis_id, latest_analysis_status: "queued" })
      .eq("id", contract_id);

    const job = { analysis_id, contract_id, user_id: userId, include_redlines };

    // ── Enqueue or run inline ────────────────────────────────────────────────
    const qstashToken = process.env.QSTASH_TOKEN;

    if (qstashToken) {
      // Async: let QStash call the worker
      const baseUrl =
        process.env.QSTASH_WORKER_URL ??
        (process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}/api/worker/analyze`
          : null);

      if (baseUrl) {
        try {
          await enqueueViaQStash(job, baseUrl);
        } catch (qErr) {
          console.error("[analyze] QStash publish failed, running inline:", qErr);
          // Fall through to inline processing below
          await processAnalysis(job);
        }
      } else {
        console.warn("[analyze] QSTASH_TOKEN set but no worker URL — running inline");
        await processAnalysis(job);
      }
    } else {
      // Sync fallback: run analysis in this request
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
    console.error("[analyze] FATAL:", err);
    return res.status(500).json({ error: "An unexpected error occurred. Please try again." });
  }
}
