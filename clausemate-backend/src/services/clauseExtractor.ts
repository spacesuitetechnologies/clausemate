import { extractClauses as llmExtractClauses } from "./llm";
import type { ExtractedClause } from "../types";

export interface ExtractAndNormalizeResult {
  clauses: ExtractedClause[];
  inputTokens: number;
  outputTokens: number;
}

/* ── Clause Category Normalization ────────────────── */

const VALID_CATEGORIES = new Set([
  "payment",
  "liability",
  "non_compete",
  "ip",
  "termination",
  "dispute",
  "indemnification",
  "confidentiality",
  "renewal",
  "jurisdiction",
  "warranty",
  "force_majeure",
  "data_protection",
  "general",
]);

function normalizeCategory(category: string): string {
  const normalized = category.toLowerCase().replace(/[\s-]/g, "_");
  if (VALID_CATEGORIES.has(normalized)) return normalized;

  // Common aliases
  const aliases: Record<string, string> = {
    intellectual_property: "ip",
    noncompete: "non_compete",
    non_competition: "non_compete",
    limitation_of_liability: "liability",
    damages: "liability",
    compensation: "payment",
    billing: "payment",
    arbitration: "dispute",
    mediation: "dispute",
    resolution: "dispute",
    nda: "confidentiality",
    secrecy: "confidentiality",
    auto_renewal: "renewal",
    automatic_renewal: "renewal",
    governing_law: "jurisdiction",
    applicable_law: "jurisdiction",
    privacy: "data_protection",
    gdpr: "data_protection",
    guarantee: "warranty",
    representations: "warranty",
    majeure: "force_majeure",
  };

  for (const [alias, target] of Object.entries(aliases)) {
    if (normalized.includes(alias)) return target;
  }

  return "general";
}

/* ── Risk Level Inference ─────────────────────────── */

function inferRiskLevelFromKeyTerms(
  keyTerms: Record<string, string | number | boolean>
): "low" | "medium" | "high" | "critical" | null {
  // Quick heuristic before policy engine runs
  if (keyTerms.liability === "uncapped") return "high";
  if (keyTerms.indemnification === "unlimited") return "high";
  if (typeof keyTerms.payment_days === "number" && keyTerms.payment_days > 60) return "high";
  if (typeof keyTerms.non_compete_months === "number" && keyTerms.non_compete_months > 12)
    return "high";
  if (keyTerms.ip_assignment === "all") return "high";
  return null;
}

/* ── Clause Extraction Pipeline ───────────────────── */

export async function extractAndNormalizeClauses(
  contractText: string
): Promise<ExtractAndNormalizeResult> {
  // Step 1: LLM extraction
  const { clauses: rawClauses, inputTokens, outputTokens } = await llmExtractClauses(contractText);

  // Step 2: Validate and normalize
  const normalizedClauses: ExtractedClause[] = rawClauses
    .filter((clause) => clause.text && clause.text.trim().length > 0)
    .map((clause, index) => ({
      clause_number: clause.clause_number || index + 1,
      title: clause.title || `Clause ${index + 1}`,
      text: clause.text.trim(),
      category: normalizeCategory(clause.category || "general"),
      key_terms: clause.key_terms || {},
    }));

  // Step 3: Re-number sequentially
  normalizedClauses.forEach((clause, index) => {
    clause.clause_number = index + 1;
  });

  return { clauses: normalizedClauses, inputTokens, outputTokens };
}

/**
 * Get a preliminary risk assessment before policy engine runs.
 * Used for quick estimation.
 */
export function preliminaryRiskAssessment(
  clauses: ExtractedClause[]
): Map<number, "low" | "medium" | "high" | "critical"> {
  const riskMap = new Map<number, "low" | "medium" | "high" | "critical">();

  for (const clause of clauses) {
    const inferred = inferRiskLevelFromKeyTerms(clause.key_terms);
    riskMap.set(clause.clause_number, inferred || "low");
  }

  return riskMap;
}
