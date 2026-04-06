import type { LLMResult, LLMUsage, StructuredRisk, StructuredClauses } from "./types";
import { callLLM } from "./aiProvider";

const RISK_LEVEL_SCORE: Record<string, number> = { high: 80, medium: 50, low: 20 };

// ── Prompt ────────────────────────────────────────────────────────────────────

export function buildPrompt(contractText: string): string {
  return `You are an expert Indian contract lawyer and risk analyst with deep knowledge of:
- Indian Contract Act, 1872
- Specific Relief Act, 1963
- Arbitration and Conciliation Act, 1996
- MSME Development Act, 2006 (payment protection)
- Information Technology Act, 2000 (for digital/IP clauses)

Analyze the contract below and return ONLY valid JSON — no markdown fences, no explanation, no text outside the JSON.

Required JSON format:
{
  "parties": ["Party 1 full name", "Party 2 full name"],
  "effective_date": "YYYY-MM-DD or descriptive date string, or null",
  "jurisdiction": "Governing law / jurisdiction string, or null",
  "summary": "2-3 lines in plain English: what this contract is, who it binds, its biggest risk, and key concern for the weaker party",
  "risks": [
    {
      "level": "high",
      "clause": "Exact clause name from the contract",
      "issue": "What is wrong or one-sided in plain language",
      "impact": "Real-world consequence with specifics (e.g. 'You could owe unlimited damages')",
      "reason": "Why this is a legal or financial risk under Indian law"
    }
  ],
  "missing_clauses": [
    {
      "clause": "Clause name",
      "importance": "Why this clause is standard in Indian contracts of this type",
      "risk": "What could go wrong without it under Indian law"
    }
  ],
  "suggestions": [
    {
      "clause": "Clause name",
      "fix": "Specific negotiation change or addition — be concrete and actionable"
    }
  ],
  "clauses": ["Termination", "Payment", "Liability"],
  "risk_score": 65
}

Rules:
- Be specific: reference actual clause language from the contract
- Flag Indian-specific issues: 45-day MSME payment rule, one-sided arbitrator appointment, perpetual IP assignments, unreasonable non-competes (India courts routinely void >12 month, national scope)
- risks: 2-8 genuine risks; level must be exactly "low", "medium", or "high"
- missing_clauses: 1-5 clauses absent that parties in India should insist on
- suggestions: 1-5 concrete negotiation points
- clauses: all major clause types present in the contract
- risk_score: 0-100 integer (0=safe, 100=extremely dangerous)
- Keep values concise but specific

CONTRACT:
${contractText}`;
}

// ── Response parser ───────────────────────────────────────────────────────────

export function parseLLMResponse(raw: string): LLMResult {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/```\s*$/m, "")
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("LLM returned no JSON object");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("LLM returned invalid JSON");
  }

  const structuredRisks: StructuredRisk[] = Array.isArray(parsed.risks)
    ? (parsed.risks as unknown[])
        .flatMap((r) => {
          if (typeof r === "object" && r !== null) {
            const obj = r as Record<string, unknown>;
            const level = String(obj.level ?? "medium").toLowerCase();
            const validLevel = (["low", "medium", "high"].includes(level)
              ? level
              : "medium") as StructuredRisk["level"];
            const reason = String(obj.reason ?? obj.issue ?? "").trim();
            if (!reason) return [];
            return [
              {
                level: validLevel,
                reason,
                ...(obj.clause != null ? { clause: String(obj.clause) } : {}),
                ...(obj.issue != null ? { issue: String(obj.issue) } : {}),
                ...(obj.impact != null ? { impact: String(obj.impact) } : {}),
              },
            ];
          }
          if (typeof r === "string" && r.trim()) {
            return [{ level: "medium" as const, reason: r.trim() }];
          }
          return [];
        })
        .filter((r) => r.reason)
    : [];

  const rawClauses =
    typeof parsed.clauses === "object" &&
    parsed.clauses !== null &&
    !Array.isArray(parsed.clauses)
      ? (parsed.clauses as Record<string, unknown>)
      : {};

  const clauseNames: string[] = Array.isArray(parsed.clauses)
    ? (parsed.clauses as unknown[]).map(String).filter(Boolean)
    : [];

  const structuredClauses: StructuredClauses = {
    termination:
      rawClauses.termination != null
        ? String(rawClauses.termination)
        : (clauseNames.find((c) => /terminat/i.test(c)) ?? null),
    payment:
      rawClauses.payment != null
        ? String(rawClauses.payment)
        : (clauseNames.find((c) => /payment|invoice|fee/i.test(c)) ?? null),
    liability:
      rawClauses.liability != null
        ? String(rawClauses.liability)
        : (clauseNames.find((c) => /liabilit/i.test(c)) ?? null),
  };

  const risks: string[] = structuredRisks.map((r) => `[${r.level}] ${r.reason}`);

  const clauses: string[] =
    clauseNames.length > 0
      ? clauseNames
      : Object.entries(structuredClauses)
          .filter(([, v]) => v !== null)
          .map(([k]) => k.charAt(0).toUpperCase() + k.slice(1));

  const modelScore = typeof parsed.risk_score === "number" ? parsed.risk_score : null;
  const computedScore =
    structuredRisks.length > 0
      ? Math.round(
          structuredRisks.reduce((sum, r) => sum + (RISK_LEVEL_SCORE[r.level] ?? 50), 0) /
            structuredRisks.length,
        )
      : 50;
  const risk_score =
    modelScore !== null && modelScore >= 0 && modelScore <= 100
      ? Math.round(modelScore)
      : computedScore;

  const missing_clauses = Array.isArray(parsed.missing_clauses)
    ? (parsed.missing_clauses as unknown[]).flatMap((m) => {
        if (typeof m === "object" && m !== null) {
          const obj = m as Record<string, unknown>;
          const clause = String(obj.clause ?? "").trim();
          if (!clause) return [];
          return [
            { clause, importance: String(obj.importance ?? ""), risk: String(obj.risk ?? "") },
          ];
        }
        return [];
      })
    : [];

  const suggestions = Array.isArray(parsed.suggestions)
    ? (parsed.suggestions as unknown[]).flatMap((s) => {
        if (typeof s === "object" && s !== null) {
          const obj = s as Record<string, unknown>;
          const clause = String(obj.clause ?? "").trim();
          if (!clause) return [];
          return [{ clause, fix: String(obj.fix ?? "") }];
        }
        return [];
      })
    : [];

  const parties = Array.isArray(parsed.parties)
    ? (parsed.parties as unknown[]).map(String).filter(Boolean)
    : [];

  return {
    summary: String(parsed.summary ?? "Contract analysis complete."),
    risk_score,
    risks,
    clauses,
    parties,
    effective_date: parsed.effective_date != null ? String(parsed.effective_date) : null,
    jurisdiction: parsed.jurisdiction != null ? String(parsed.jurisdiction) : null,
    structured_risks: structuredRisks,
    structured_clauses: structuredClauses,
    missing_clauses,
    suggestions,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface LLMAnalysisResult {
  result: LLMResult;
  usage: LLMUsage;
}

export async function analyzeWithLLM(contractText: string): Promise<LLMAnalysisResult> {
  const { text, provider, usage } = await callLLM(buildPrompt(contractText), {
    maxTokens: 2048,
    jsonMode: true,
  });
  return { result: parseLLMResponse(text), usage: { ...usage, provider } };
}
