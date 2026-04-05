import type { LLMResult, StructuredRisk, StructuredClauses } from "./types";

const RISK_LEVEL_SCORE: Record<string, number> = { high: 80, medium: 50, low: 20 };

// ── Prompt ────────────────────────────────────────────────────────────────────

export function buildPrompt(contractText: string): string {
  return `You are an expert contract risk analyst.

Analyze the contract and return ONLY valid JSON — no markdown, no explanation, no text outside the JSON.

Required JSON format:
{
  "parties": ["Party 1 name", "Party 2 name"],
  "effective_date": "YYYY-MM-DD or descriptive date string, or null if not found",
  "jurisdiction": "Governing law / jurisdiction string, or null if not found",
  "summary": "2-3 lines in simple English: what this contract is, who it binds, and its biggest concern",
  "risks": [
    {
      "level": "high",
      "clause": "Name of the clause (e.g. Indemnification)",
      "issue": "What is wrong or one-sided",
      "impact": "Real-world consequence (e.g. You may owe unlimited damages)",
      "reason": "Why this is a risk"
    }
  ],
  "missing_clauses": [
    {
      "clause": "Clause name (e.g. Limitation of Liability)",
      "importance": "Why this clause is standard",
      "risk": "What could go wrong without it"
    }
  ],
  "suggestions": [
    {
      "clause": "Clause name",
      "fix": "Specific change to negotiate or add"
    }
  ],
  "clauses": ["Termination", "Payment", "Liability"],
  "risk_score": 65
}

Rules:
- Be specific, not generic — reference actual clause language where possible
- Mention money or legal consequences clearly in impact fields
- risks: list 2-6 genuine risks; level must be exactly "low", "medium", or "high"
- missing_clauses: list 1-4 clauses absent from the contract that a party should insist on
- suggestions: list 1-4 concrete negotiation fixes
- clauses: list all major clause types present in the contract
- risk_score: 0-100 integer (0=no risk, 100=extremely dangerous)
- Keep all values concise

CONTRACT:
${contractText}`;
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function callAnthropic(text: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: buildPrompt(text) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content?.[0]?.text ?? "";
}

async function callOpenAI(text: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: buildPrompt(text) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

// ── Response parser ───────────────────────────────────────────────────────────

export function parseLLMResponse(raw: string): LLMResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
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
            const reason = String(obj.reason ?? obj.issue ?? "");
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
          if (typeof r === "string") return [{ level: "medium" as const, reason: r }];
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

  const clauses: string[] = Array.isArray(parsed.clauses)
    ? (parsed.clauses as unknown[]).map(String).filter(Boolean)
    : Object.entries(structuredClauses)
        .filter(([, v]) => v !== null)
        .map(([k]) => k.charAt(0).toUpperCase() + k.slice(1));

  const modelScore = typeof parsed.risk_score === "number" ? parsed.risk_score : null;
  const risk_score =
    modelScore !== null && modelScore >= 0 && modelScore <= 100
      ? Math.round(modelScore)
      : structuredRisks.length > 0
        ? Math.round(
            structuredRisks.reduce(
              (sum, r) => sum + (RISK_LEVEL_SCORE[r.level] ?? 50),
              0,
            ) / structuredRisks.length,
          )
        : 50;

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

export async function analyzeWithLLM(contractText: string): Promise<LLMResult> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return parseLLMResponse(await callAnthropic(contractText));
    } catch (err) {
      console.error(
        "[llm] Anthropic failed, falling back to OpenAI:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (process.env.OPENAI_API_KEY) {
    return parseLLMResponse(await callOpenAI(contractText));
  }

  throw new Error(
    "No LLM API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
  );
}
