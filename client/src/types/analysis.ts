/**
 * Canonical frontend types for contract analysis.
 * Single source of truth — all components reference these, never raw API shapes.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface ClauseResult {
  id: string;
  type: string;
  title: string;
  text: string;
  risk_level: RiskLevel;
  score: number;
  explanation: string;
  issues: string[];
  suggestion?: string;
}

export interface ContractAnalysis {
  id: string;
  contract_id: string;
  contract_name: string;
  overall_score: number;
  risk_level: RiskLevel;
  status: "queued" | "processing" | "completed" | "failed";
  credits_actual: number | null;
  include_redlines: boolean;
  error: string | null;
  clauses: ClauseResult[];
}

// ── Raw backend response shapes (snake_case, as returned by API) ─────────────

export interface RawPolicyViolation {
  policyId: string;
  policyName: string;
  riskLevel: string;
  explanation: string;
}

export interface RawClause {
  id: string;
  clause_number: number;
  type?: string | null;
  title: string;
  text: string;
  risk_level: string;
  score?: number | null;
  explanation: string | null;
  suggested_rewrite?: string | null;
  policy_violations: RawPolicyViolation[] | null;
  issues?: string[] | null;
}

export interface AnalysisResponse {
  id: string;
  contract_id: string;
  contract_name: string;
  status: "queued" | "processing" | "completed" | "failed";
  risk_score: number | null;
  credits_estimated: number;
  credits_actual: number | null;
  include_redlines: boolean;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  clauses: RawClause[];
}

// ── Contract list shape ───────────────────────────────────────────────────────

export interface ContractSummary {
  id: string;
  name: string;
  file_size: number;
  status: string;
  created_at: string;
  risk_score?: number | null;
  high_risk_count?: number | null;
  clause_count?: number | null;
  latest_analysis_id?: string | null;
  latest_analysis_status?: "queued" | "processing" | "completed" | "failed" | null;
}
