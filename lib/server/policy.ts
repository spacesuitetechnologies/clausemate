import type { LLMResult, StructuredRisk } from "./types";

interface Policy {
  name: string;
  category: string;
  risk_level: "low" | "medium" | "high";
  explanation: string;
  check: (result: LLMResult) => boolean;
}

const BUILT_IN_POLICIES: Policy[] = [
  {
    name: "Missing Indemnification Clause",
    category: "indemnification",
    risk_level: "high",
    explanation:
      "No indemnification clause found. Either party may be exposed to unlimited third-party claims without contractual protection.",
    check: (r) =>
      !r.clauses.some((c) => /indemni/i.test(c)) &&
      !r.structured_clauses.liability &&
      !r.missing_clauses.some((m) => /indemni/i.test(m.clause)),
  },
  {
    name: "Missing Limitation of Liability",
    category: "liability",
    risk_level: "high",
    explanation:
      "No limitation of liability clause detected. Damages could be uncapped — a significant financial exposure.",
    check: (r) =>
      !r.clauses.some((c) => /liabilit/i.test(c)) && !r.structured_clauses.liability,
  },
  {
    name: "Missing Termination Clause",
    category: "termination",
    risk_level: "medium",
    explanation:
      "No termination clause found. Either party may be locked into the contract with no clear exit mechanism.",
    check: (r) =>
      !r.clauses.some((c) => /terminat/i.test(c)) && !r.structured_clauses.termination,
  },
  {
    name: "Missing Dispute Resolution",
    category: "dispute",
    risk_level: "medium",
    explanation:
      "No dispute resolution or arbitration clause found. Disputes will default to litigation, which is costly and slow.",
    check: (r) => !r.clauses.some((c) => /dispute|arbitrat|mediat/i.test(c)),
  },
  {
    name: "Missing Governing Law / Jurisdiction",
    category: "jurisdiction",
    risk_level: "medium",
    explanation:
      "No governing law or jurisdiction specified. In cross-border contracts this creates ambiguity about which courts and laws apply.",
    check: (r) =>
      !r.jurisdiction && !r.clauses.some((c) => /jurisdiction|governing law/i.test(c)),
  },
  {
    name: "Missing Confidentiality Clause",
    category: "confidentiality",
    risk_level: "medium",
    explanation:
      "No confidentiality or NDA clause found. Sensitive business information shared under this contract may not be protected.",
    check: (r) => !r.clauses.some((c) => /confidential|nda|non-disclosure/i.test(c)),
  },
  {
    name: "Missing Payment Terms",
    category: "payment",
    risk_level: "medium",
    explanation:
      "No payment terms clause found. Without defined payment schedules and penalties, late or non-payment may go unaddressed.",
    check: (r) =>
      !r.clauses.some((c) => /payment|invoice|fee/i.test(c)) && !r.structured_clauses.payment,
  },
  {
    name: "Missing Intellectual Property Ownership",
    category: "ip",
    risk_level: "medium",
    explanation:
      "No IP ownership clause detected. Work product or inventions created under this contract may have unclear ownership.",
    check: (r) =>
      !r.clauses.some((c) =>
        /intellectual property|ip ownership|copyright|work for hire/i.test(c),
      ),
  },
  {
    name: "Missing Force Majeure",
    category: "force_majeure",
    risk_level: "low",
    explanation:
      "No force majeure clause found. Parties may have no protection against liability for events outside their control.",
    check: (r) => !r.clauses.some((c) => /force majeure|act of god|unforeseeable/i.test(c)),
  },
];

export function evaluatePolicies(result: LLMResult): StructuredRisk[] {
  const triggered = BUILT_IN_POLICIES.filter((p) => p.check(result));

  const existingReasons = new Set(
    result.structured_risks.map((r) => (r.clause ?? r.reason).toLowerCase()),
  );

  return triggered
    .filter((p) => {
      const key = p.category.toLowerCase();
      return !Array.from(existingReasons).some((r) => r.includes(key));
    })
    .map((p) => ({
      level: p.risk_level,
      reason: p.explanation,
      clause: p.name,
    }));
}

export function mergeWithPolicyRisks(result: LLMResult): LLMResult {
  const policyRisks = evaluatePolicies(result);
  if (policyRisks.length === 0) return result;

  const allRisks = [...result.structured_risks, ...policyRisks];
  const RISK_SCORE: Record<string, number> = { high: 80, medium: 50, low: 20 };
  const newScore = Math.round(
    allRisks.reduce((sum, r) => sum + (RISK_SCORE[r.level] ?? 50), 0) / allRisks.length,
  );

  return {
    ...result,
    structured_risks: allRisks,
    risks: allRisks.map((r) => `[${r.level}] ${r.reason}`),
    risk_score: newScore,
  };
}
