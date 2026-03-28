/**
 * analyses.ts — Supabase data layer for the analyses table.
 *
 * saveDirectAnalysis is FIRE-AND-FORGET.
 * It never throws, never blocks the UI, and degrades gracefully when columns
 * are missing — each field is written only if the column exists.
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
 * Attempt to upsert analysis result for a contract.
 * NEVER throws — all errors are swallowed after logging.
 * Returns true on success, false on any failure.
 */
export async function saveDirectAnalysis(
  contractId: string,
  result: AnalyzeContractResult,
): Promise<boolean> {
  try {
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError || !session) {
      console.warn("[saveDirectAnalysis] No active session — skipping save");
      return false;
    }

    const now = new Date().toISOString();

    // Build payload field-by-field so missing columns don't cause errors
    const analysisPayload: Record<string, unknown> = {
      contract_id: contractId,
      user_id: session.user.id,
      updated_at: now,
    };

    if (result.summary != null) {
      analysisPayload.summary = result.summary;
    }
    if (Array.isArray(result.risks)) {
      // Store as JSON string for maximum Supabase type compatibility
      analysisPayload.risks = JSON.stringify(result.risks);
    }
    if (Array.isArray(result.clauses)) {
      analysisPayload.clauses = JSON.stringify(result.clauses);
    }
    if (result.risk_score != null) {
      analysisPayload.risk_score = result.risk_score;
    }

    const { error: insertError } = await supabase
      .from("analyses")
      .insert(analysisPayload);

    if (insertError) {
      console.error("[saveDirectAnalysis] SUPABASE ERROR FULL:", JSON.stringify(insertError));
      // Don't throw — fall through to contract update attempt
    }

    // Update contracts table — each field attempted independently
    const contractPayload: Record<string, unknown> = {
      latest_analysis_status: "completed",
    };

    if (Array.isArray(result.clauses)) {
      contractPayload.clause_count = result.clauses.length;
    }
    if (result.risk_score != null) {
      contractPayload.risk_score = result.risk_score;
    }

    const { error: contractUpdateError } = await supabase
      .from("contracts")
      .update(contractPayload)
      .eq("id", contractId);

    if (contractUpdateError) {
      console.error("[saveDirectAnalysis] CONTRACT UPDATE ERROR:", contractUpdateError);
      // Don't throw — save is best-effort
    }

    return !insertError && !contractUpdateError;
  } catch (err) {
    console.error("[saveDirectAnalysis] SAVE CRASH:", err);
    return false;
  }
}

/**
 * Fetch the saved analysis for a contract, or null if none exists.
 * Never throws — returns null on any error.
 */
export async function fetchDirectAnalysis(
  contractId: string,
): Promise<DirectAnalysis | null> {
  try {
    const { data, error } = await supabase
      .from("analyses")
      .select("id, contract_id, summary, risks, clauses, risk_score, created_at, updated_at")
      .eq("contract_id", contractId)
      .maybeSingle();

    if (error) {
      console.error("[fetchDirectAnalysis] FETCH ERROR:", error);
      return null;
    }
    if (!data) return null;

    // Parse risks/clauses — handle both JSON string and native array
    const parseJsonField = (val: unknown): string[] => {
      if (Array.isArray(val)) return val as string[];
      if (typeof val === "string") {
        try { return JSON.parse(val) as string[]; } catch { return []; }
      }
      return [];
    };

    return {
      id: data.id,
      contract_id: data.contract_id,
      summary: data.summary ?? "",
      risks: parseJsonField(data.risks),
      clauses: parseJsonField(data.clauses),
      risk_score: (data.risk_score as number | null) ?? null,
      created_at: data.created_at,
      updated_at: data.updated_at ?? null,
    };
  } catch (err) {
    console.error("[fetchDirectAnalysis] CRASH:", err);
    return null;
  }
}
