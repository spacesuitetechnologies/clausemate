/**
 * GET /api/contracts/:id/analysis
 *
 * Returns the latest completed analysis for a contract.
 * Returns data in AnalysisResponse shape for backward compatibility with the Reports page.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getUserIdFromToken, getServiceClient } from "../../../lib/server/supabase";
import type { AnalyzeContractResult, StructuredRisk } from "../../../lib/server/types";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const authHeader = (req.headers?.authorization as string) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  let userId: string;
  try {
    userId = await getUserIdFromToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const { id: contractId } = req.query;
  if (!contractId || typeof contractId !== "string") {
    return res.status(400).json({ error: "Contract ID is required" });
  }

  try {
    const db = getServiceClient();

    // Verify ownership
    const { data: contract, error: contractErr } = await db
      .from("contracts")
      .select("id, filename")
      .eq("id", contractId)
      .eq("user_id", userId)
      .single();

    if (contractErr || !contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    // Get latest analysis
    const { data: analysis, error: analysisErr } = await db
      .from("analyses")
      .select("id, contract_id, status, full_result, error, risk_score, credits_actual, include_redlines, updated_at")
      .eq("contract_id", contractId)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (analysisErr || !analysis) {
      return res.status(404).json({ error: "No analysis found for this contract" });
    }

    const full = analysis.full_result as AnalyzeContractResult | null;

    // Map structured_risks → RawClause[] for the existing frontend mapper
    const clauses = (full?.structured_risks ?? []).map((risk: StructuredRisk, i: number) => ({
      id: `${analysis.id}-${i}`,
      clause_number: i + 1,
      type: risk.clause ?? "risk",
      title: risk.clause ?? `Risk ${i + 1}`,
      text: risk.issue ?? risk.reason,
      risk_level: risk.level,
      score: risk.level === "high" ? 75 : risk.level === "medium" ? 50 : 20,
      explanation: risk.reason,
      suggested_rewrite: null,
      policy_violations: null,
      issues: risk.impact ? [risk.impact] : [],
    }));

    return res.status(200).json({
      id: analysis.id,
      contract_id: analysis.contract_id,
      contract_name: contract.filename ?? "Unknown Contract",
      status: analysis.status ?? "completed",
      risk_score: analysis.risk_score ?? full?.risk_score ?? null,
      credits_estimated: 10,
      credits_actual: analysis.credits_actual ?? null,
      include_redlines: analysis.include_redlines ?? false,
      started_at: null,
      completed_at: analysis.updated_at ?? null,
      error: analysis.error ?? null,
      clauses,
    });
  } catch (err: unknown) {
    console.error("[contracts/analysis] Error:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Could not retrieve analysis." });
  }
}
