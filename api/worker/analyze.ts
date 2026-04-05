/**
 * POST /api/worker/analyze
 *
 * QStash worker endpoint. Called by Upstash QStash after /api/analyze enqueues a job.
 * Verifies the QStash signature, then runs the full analysis pipeline.
 *
 * Also callable directly (without signature verification) when QSTASH_TOKEN is not set.
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
import { processAnalysis } from "../../lib/server/process-analysis";
import type { AnalysisJob } from "../../lib/server/types";

async function verifyQStashSignature(req: VercelRequest): Promise<boolean> {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentKey || !nextKey) return true; // No keys configured — skip verification

  const signature = req.headers["upstash-signature"] as string | undefined;
  if (!signature) return false;

  try {
    const { Receiver } = await import("@upstash/qstash");
    const receiver = new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });

    // Read raw body for signature verification
    const body =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});

    await receiver.verify({ signature, body });
    return true;
  } catch (err) {
    console.error("[worker] Signature verification failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ── Signature verification ────────────────────────────────────────────────
  const isValid = await verifyQStashSignature(req);
  if (!isValid) {
    return res.status(401).json({ error: "Invalid QStash signature" });
  }

  // ── Parse job payload ─────────────────────────────────────────────────────
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { analysis_id, contract_id, user_id, include_redlines } = body;

  if (
    !analysis_id || typeof analysis_id !== "string" ||
    !contract_id || typeof contract_id !== "string" ||
    !user_id || typeof user_id !== "string"
  ) {
    return res.status(400).json({ error: "Invalid job payload" });
  }

  const job: AnalysisJob = {
    analysis_id,
    contract_id,
    user_id,
    include_redlines: include_redlines === true,
  };

  // ── Process ───────────────────────────────────────────────────────────────
  try {
    await processAnalysis(job);
    return res.status(200).json({ ok: true, analysis_id });
  } catch (err: unknown) {
    // processAnalysis handles its own error state in Supabase — this catch is a last resort
    console.error("[worker] Unhandled error:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Worker encountered an unexpected error" });
  }
}
