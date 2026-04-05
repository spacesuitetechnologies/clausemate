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
import type { JobStatusResponse, AnalyzeContractResult } from "@/lib/api";

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

/**
 * Maps a JobStatusResponse (from GET /api/analysis/:id) into a ContractAnalysis.
 * Derives clauses from structured_risks if present.
 */
export function mapJobResult(job: JobStatusResponse): ContractAnalysis {
  const result = job.result as (AnalyzeContractResult & { structured_risks?: Array<{ clause: string; issue: string; level: string; reason: string; impact: string; suggestion: string }> }) | null;
  const riskScore = result?.risk_score ?? 0;
  const structuredRisks = result?.structured_risks ?? [];

  const clauses: ClauseResult[] = structuredRisks.map((r, i) => ({
    id: `${job.id}-${i}`,
    type: r.clause ?? "risk",
    title: r.clause ?? `Risk ${i + 1}`,
    text: r.issue ?? r.reason ?? "",
    risk_level: normalizeRiskLevel(r.level),
    score: r.level === "high" ? 75 : r.level === "medium" ? 50 : 20,
    explanation: r.reason ?? "",
    issues: r.impact ? [r.impact] : [],
    suggestion: r.suggestion ?? undefined,
  }));

  return {
    id: job.id,
    contract_id: job.contract_id,
    contract_name: "Contract",
    overall_score: typeof riskScore === "number" ? riskScore : 0,
    risk_level: riskScoreToLevel(typeof riskScore === "number" ? riskScore : 0),
    status: job.status,
    credits_actual: job.credits_actual,
    include_redlines: false,
    error: job.error,
    clauses,
  };
}
