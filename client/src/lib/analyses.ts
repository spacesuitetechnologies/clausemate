/**
 * analyses.ts — Supabase data layer for the analyses table.
 *
 * saveDirectAnalysis(contractId, result)
 *   → Upserts one row per contract (UNIQUE on contract_id)
 *   → Also marks contracts.latest_analysis_status = 'completed'
 *   → Writes risk_score to both analyses and contracts tables
 *
 * fetchDirectAnalysis(contractId)
 *   → Returns the saved analysis for a contract, or null
 *
 * Required Supabase table (run once):
 *
 *   CREATE TABLE analyses (
 *     id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
 *     contract_id UUID REFERENCES contracts(id) ON DELETE CASCADE,
 *     user_id     UUID REFERENCES auth.users(id) NOT NULL,
 *     summary     TEXT,
 *     risks       JSONB DEFAULT '[]',
 *     clauses     JSONB DEFAULT '[]',
 *     risk_score  NUMERIC,
 *     created_at  TIMESTAMPTZ DEFAULT NOW(),
 *     updated_at  TIMESTAMPTZ DEFAULT NOW(),
 *     UNIQUE (contract_id)
 *   );
 *
 *   ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "Users see own analyses" ON analyses
 *     FOR ALL USING (auth.uid() = user_id);
 */

import { supabase } from "@/lib/supabase";
import type { AnalyzeContractResult } from "@/lib/api";

export interface DirectAnalysis {
  id: string;
  contract_id: string;
  summary: string;
  risks: string[];
  clauses: string[];
  risk_score: number | null;
  created_at: string;
  updated_at: string | null;
}

/**
 * Upsert analysis result for a contract.
 * Calling this twice for the same contract replaces the previous result.
 * Also updates the parent contract row so the Reports list reflects the status.
 */
export async function saveDirectAnalysis(
  contractId: string,
  result: AnalyzeContractResult,
): Promise<void> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError || !session) throw new Error("Not authenticated");

  const now = new Date().toISOString();

  const { error: upsertError } = await supabase
    .from("analyses")
    .upsert(
      {
        contract_id: contractId,
        user_id: session.user.id,
        summary: result.summary,
        risks: result.risks,
        clauses: result.clauses,
        risk_score: result.risk_score ?? null,
        updated_at: now,
      },
      { onConflict: "contract_id" },
    );

  if (upsertError) throw new Error(upsertError.message);

  // Keep contracts table in sync so the Reports list badge and risk score update
  const { error: contractUpdateError } = await supabase
    .from("contracts")
    .update({
      latest_analysis_status: "completed",
      clause_count: result.clauses.length,
      ...(result.risk_score != null ? { risk_score: result.risk_score } : {}),
    })
    .eq("id", contractId);

  if (contractUpdateError) throw new Error(contractUpdateError.message);
}

/**
 * Fetch the saved analysis for a contract, or null if none exists.
 */
export async function fetchDirectAnalysis(
  contractId: string,
): Promise<DirectAnalysis | null> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, contract_id, summary, risks, clauses, risk_score, created_at, updated_at")
    .eq("contract_id", contractId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    id: data.id,
    contract_id: data.contract_id,
    summary: data.summary ?? "",
    risks: (data.risks as string[]) ?? [],
    clauses: (data.clauses as string[]) ?? [],
    risk_score: (data.risk_score as number | null) ?? null,
    created_at: data.created_at,
    updated_at: data.updated_at ?? null,
  };
}
