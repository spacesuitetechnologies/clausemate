/**
 * GET /api/analysis/:id
 *
 * Returns the current status and result of an analysis job.
 * Only accessible by the user who owns the analysis.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getUserIdFromToken, getServiceClient } from "../../lib/server/supabase";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
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

  // ── Resolve analysis ID ───────────────────────────────────────────────────
  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Analysis ID is required" });
  }

  // ── Fetch from Supabase ───────────────────────────────────────────────────
  try {
    const db = getServiceClient();
    const { data, error } = await db
      .from("analyses")
      .select("id, contract_id, status, full_result, error, risk_score, credits_actual, updated_at")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Analysis not found" });
    }

    return res.status(200).json({
      id: data.id,
      contract_id: data.contract_id,
      status: data.status ?? "completed",
      result: data.full_result ?? null,
      error: data.error ?? null,
      credits_actual: data.credits_actual ?? null,
      updated_at: data.updated_at ?? null,
    });
  } catch (err: unknown) {
    console.error("[analysis/id] Error:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Could not retrieve analysis. Please try again." });
  }
}
