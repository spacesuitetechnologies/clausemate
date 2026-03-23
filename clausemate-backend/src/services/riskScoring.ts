import type { PolicyViolation } from "../db/schema";

/* ── Category Weights ─────────────────────────────── */

const CATEGORY_WEIGHTS: Record<string, number> = {
  liability: 15,
  indemnification: 14,
  ip: 13,
  payment: 12,
  non_compete: 11,
  termination: 10,
  dispute: 9,
  confidentiality: 8,
  jurisdiction: 7,
  renewal: 6,
  warranty: 5,
  data_protection: 8,
  force_majeure: 4,
  general: 3,
};

/* ── Risk Level Multipliers ───────────────────────── */

const RISK_MULTIPLIERS: Record<string, number> = {
  low: 0.1,
  medium: 0.4,
  high: 0.75,
  critical: 1.0,
};

/* ── Types ────────────────────────────────────────── */

export interface ClauseRiskInput {
  clauseNumber: number;
  category: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  policyViolations: PolicyViolation[];
}

export interface RiskScoreResult {
  overallScore: number;
  /** Raw (un-normalized) per-clause scores. */
  clauseScores: Map<number, number>;
  /** Per-clause scores normalized to 0-100, ready to persist to DB. */
  normalizedClauseScores: Map<number, number>;
  riskDistribution: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
}

/* ── Scoring Functions ────────────────────────────── */

function computeClauseScore(clause: ClauseRiskInput): number {
  const categoryWeight = CATEGORY_WEIGHTS[clause.category] || CATEGORY_WEIGHTS.general;
  const riskMultiplier = RISK_MULTIPLIERS[clause.riskLevel] || RISK_MULTIPLIERS.low;

  // Base score from risk level and category weight
  let score = categoryWeight * riskMultiplier;

  // Bonus for each policy violation (stacking effect, up to 50% bonus)
  const violationBonus = Math.min(clause.policyViolations.length * 0.15, 0.5);
  score *= 1 + violationBonus;

  return score;
}

export function computeRiskScore(clauses: ClauseRiskInput[]): RiskScoreResult {
  if (clauses.length === 0) {
    return {
      overallScore: 0,
      clauseScores: new Map(),
      normalizedClauseScores: new Map(),
      riskDistribution: { low: 0, medium: 0, high: 0, critical: 0 },
    };
  }

  const clauseScores = new Map<number, number>();
  const riskDistribution = { low: 0, medium: 0, high: 0, critical: 0 };

  let totalWeightedScore = 0;
  let maxPossibleScore = 0;

  for (const clause of clauses) {
    const score = computeClauseScore(clause);
    clauseScores.set(clause.clauseNumber, score);
    totalWeightedScore += score;
    riskDistribution[clause.riskLevel]++;

    // Max possible score: category weight * critical multiplier * max violation bonus
    const categoryWeight = CATEGORY_WEIGHTS[clause.category] || CATEGORY_WEIGHTS.general;
    maxPossibleScore += categoryWeight * RISK_MULTIPLIERS.critical * 1.5;
  }

  // Normalize overall score to 0-100
  const overallScore =
    maxPossibleScore > 0
      ? Math.round(Math.min(100, (totalWeightedScore / maxPossibleScore) * 100))
      : 0;

  // Normalize each clause score to 0-100 independently against its own max
  const normalizedClauseScores = new Map<number, number>();
  for (const clause of clauses) {
    const rawScore = clauseScores.get(clause.clauseNumber) ?? 0;
    const categoryWeight = CATEGORY_WEIGHTS[clause.category] || CATEGORY_WEIGHTS.general;
    const maxRawForClause = categoryWeight * RISK_MULTIPLIERS.critical * 1.5;
    const normalized =
      maxRawForClause > 0
        ? Math.round(Math.min(100, (rawScore / maxRawForClause) * 100))
        : 0;
    normalizedClauseScores.set(clause.clauseNumber, normalized);
  }

  return { overallScore, clauseScores, normalizedClauseScores, riskDistribution };
}

/**
 * Determine overall risk level from score.
 */
export function scoreToRiskLevel(score: number): "low" | "medium" | "high" | "critical" {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}
