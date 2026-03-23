import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import type { ExtractedClause } from "../types";
import type { PolicyViolation } from "../db/schema";
import { logger } from "../services/logger";

/* ── Types ────────────────────────────────────────── */

interface PolicyRule {
  id: string;
  name: string;
  category: string;
  conditionField: string;
  conditionOperator: string;
  conditionValue: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  explanationTemplate: string;
}

interface PolicyEvalResult {
  violations: PolicyViolation[];
  highestRiskLevel: "low" | "medium" | "high" | "critical";
}

/* ── Cache ────────────────────────────────────────── */

let cachedPolicies: PolicyRule[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/* ── Policy Loading ───────────────────────────────── */

export async function loadPolicies(): Promise<PolicyRule[]> {
  const now = Date.now();
  if (cachedPolicies && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedPolicies;
  }

  const rows = await db
    .select()
    .from(schema.policies)
    .where(eq(schema.policies.isActive, true));

  cachedPolicies = rows.map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    conditionField: row.conditionField,
    conditionOperator: row.conditionOperator,
    conditionValue: row.conditionValue,
    riskLevel: row.riskLevel,
    explanationTemplate: row.explanationTemplate,
  }));
  cacheTimestamp = now;

  return cachedPolicies;
}

export function invalidateCache(): void {
  cachedPolicies = null;
  cacheTimestamp = 0;
}

/* ── Condition Evaluation ─────────────────────────── */

function evaluateCondition(
  fieldValue: string | number | boolean | undefined,
  operator: string,
  conditionValue: string
): boolean {
  if (fieldValue === undefined || fieldValue === null) {
    return false;
  }

  switch (operator) {
    case ">": {
      const numField = Number(fieldValue);
      const numCondition = Number(conditionValue);
      return !isNaN(numField) && !isNaN(numCondition) && numField > numCondition;
    }
    case "<": {
      const numField = Number(fieldValue);
      const numCondition = Number(conditionValue);
      return !isNaN(numField) && !isNaN(numCondition) && numField < numCondition;
    }
    case ">=": {
      const numField = Number(fieldValue);
      const numCondition = Number(conditionValue);
      return !isNaN(numField) && !isNaN(numCondition) && numField >= numCondition;
    }
    case "<=": {
      const numField = Number(fieldValue);
      const numCondition = Number(conditionValue);
      return !isNaN(numField) && !isNaN(numCondition) && numField <= numCondition;
    }
    case "===":
    case "==":
      return String(fieldValue) === conditionValue;
    case "!==":
    case "!=":
      return String(fieldValue) !== conditionValue;
    case "contains":
      return String(fieldValue).toLowerCase().includes(conditionValue.toLowerCase());
    case "not_contains":
      return !String(fieldValue).toLowerCase().includes(conditionValue.toLowerCase());
    default:
      logger.warn({ operator }, "policy.unknown_operator");
      return false;
  }
}

/* ── Clause Evaluation ────────────────────────────── */

export async function evaluateClause(clause: ExtractedClause): Promise<PolicyEvalResult> {
  const policies = await loadPolicies();
  const violations: PolicyViolation[] = [];
  let highestRiskLevel: "low" | "medium" | "high" | "critical" = "low";

  const riskOrder = { low: 0, medium: 1, high: 2, critical: 3 };

  // Filter policies relevant to this clause's category or applicable to all
  const relevantPolicies = policies.filter(
    (p) => p.category === clause.category || p.category === "general"
  );

  for (const policy of relevantPolicies) {
    const fieldValue = clause.key_terms[policy.conditionField];

    if (evaluateCondition(fieldValue, policy.conditionOperator, policy.conditionValue)) {
      violations.push({
        policyId: policy.id,
        policyName: policy.name,
        riskLevel: policy.riskLevel,
        explanation: policy.explanationTemplate,
      });

      if (riskOrder[policy.riskLevel] > riskOrder[highestRiskLevel]) {
        highestRiskLevel = policy.riskLevel;
      }
    }
  }

  return { violations, highestRiskLevel };
}

/* ── Batch Evaluation ─────────────────────────────── */

export async function evaluateAllClauses(
  clauses: ExtractedClause[]
): Promise<Map<number, PolicyEvalResult>> {
  const results = new Map<number, PolicyEvalResult>();

  // Ensure policies are loaded once
  await loadPolicies();

  for (const clause of clauses) {
    const result = await evaluateClause(clause);
    results.set(clause.clause_number, result);
  }

  return results;
}
