/**
 * Mapper layer — transforms raw API responses into frontend ContractAnalysis types.
 * API responses are never used directly in UI components.
 */

import type {
  AnalysisResponse,
  ContractAnalysis,
  ClauseResult,
  RawClause,
  RiskLevel,
} from "@/types/analysis";

// ── Risk normalization ────────────────────────────────────────────────────────

function normalizeRiskLevel(raw?: string | null): RiskLevel {
  const upper = (raw ?? "").toUpperCase();
  if (upper === "CRITICAL" || upper === "HIGH") return "HIGH";
  if (upper === "MEDIUM") return "MEDIUM";
  return "LOW";
}

function riskScoreToLevel(score: number | null | undefined): RiskLevel {
  if (score == null) return "LOW";
  if (score >= 70) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
}

// ── Clause mapper ─────────────────────────────────────────────────────────────

export function mapClause(c: RawClause): ClauseResult {
  // issues: prefer explicit issues array, fall back to policy_violations explanations
  const issues: string[] =
    (c.issues?.filter(Boolean) as string[]) ??
    (c.policy_violations ?? []).map((v) => v.explanation).filter(Boolean);

  return {
    id: c.id,
    type: c.type ?? `clause_${c.clause_number}`,
    title: c.title ?? "Untitled Clause",
    text: c.text ?? "",
    risk_level: normalizeRiskLevel(c.risk_level),
    score: c.score ?? 0,
    explanation: c.explanation ?? "No explanation available.",
    issues,
    suggestion: c.suggested_rewrite ?? undefined,
  };
}

// ── Analysis mapper ───────────────────────────────────────────────────────────

export function mapAnalysisResponse(raw: AnalysisResponse): ContractAnalysis {
  const clauses = (raw.clauses ?? []).map(mapClause);
  const riskScore = raw.risk_score ?? 0;

  return {
    id: raw.id,
    contract_id: raw.contract_id,
    contract_name: raw.contract_name ?? "Unknown Contract",
    overall_score: riskScore,
    risk_level: riskScoreToLevel(riskScore),
    status: raw.status,
    credits_actual: raw.credits_actual,
    include_redlines: raw.include_redlines,
    error: raw.error,
    clauses,
  };
}
