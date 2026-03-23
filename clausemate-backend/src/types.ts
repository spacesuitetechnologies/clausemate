/* ── Plan Types ──────────────────────────────────── */

export type PlanId = "free" | "starter" | "professional" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  monthly_price: number;
  credits: number;
  overage_rate: number;
  features: string[];
}

/* ── API Response Types (matches frontend) ──────── */

export interface UserPlan {
  plan_id: PlanId;
  plan_name: string;
  credits_total: number;
  credits_used: number;
  credits_remaining: number;
  overage_credits: number;
  overage_cost: number;
  can_redline: boolean;
  can_rewrite: boolean;
}

export interface CreditUsageResponse {
  credits_used: number;
  credits_remaining: number;
  credits_total: number;
  overage_credits: number;
  overage_cost: number;
  period_start: string;
  period_end: string;
}

export interface AnalysisCost {
  estimated_credits: number;
  actual_credits: number;
  breakdown: CreditBreakdownItem[];
}

export interface CreditBreakdownItem {
  action: "analysis" | "redline" | "rewrite";
  label: string;
  credits: number;
}

/* ── Credit Constants ───────────────────────────── */

export const CREDIT_COSTS = {
  ANALYSIS_MIN: 8,
  ANALYSIS_MAX: 12,
  ANALYSIS_DEFAULT: 10,
  REDLINE: 2,
  REWRITE: 5,
} as const;

/* ── Plan Definitions ───────────────────────────── */

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    monthly_price: 0,
    credits: 10,
    overage_rate: 0,
    features: [
      "1 contract (basic analysis only)",
      "10 credits included",
      "No redlines or rewrites",
      "Email support",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    monthly_price: 999,
    credits: 100,
    overage_rate: 15,
    features: [
      "100 credits per month",
      "~10 contract analyses",
      "Basic analysis + limited redlines",
      "Email support",
      "₹15 per extra credit",
    ],
  },
  {
    id: "professional",
    name: "Professional",
    monthly_price: 2999,
    credits: 400,
    overage_rate: 12,
    features: [
      "400 credits per month",
      "~40 contract analyses",
      "Full analysis + redlines + rewrites",
      "Priority support",
      "₹12 per extra credit",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthly_price: 9999,
    credits: 1500,
    overage_rate: 8,
    features: [
      "1,500+ credits per month",
      "~150 contract analyses",
      "Full analysis + redlines + rewrites",
      "Multi-user & team features",
      "Dedicated account manager",
      "₹8 per extra credit",
    ],
  },
];

export function getPlan(id: PlanId): Plan {
  return PLANS.find((p) => p.id === id) || PLANS[0];
}

/* ── LLM Types ──────────────────────────────────── */

export interface ExtractedClause {
  clause_number: number;
  title: string;
  text: string;
  category: string;
  key_terms: Record<string, string | number | boolean>;
}

export interface ClauseAnalysisResult {
  clause_number: number;
  title: string;
  text: string;
  risk_level: "low" | "medium" | "high" | "critical";
  explanation: string;
  suggested_rewrite?: string;
  policy_violations: {
    policyId: string;
    policyName: string;
    riskLevel: string;
    explanation: string;
  }[];
}

/* ── Auth Types ──────────────────────────────────── */

export interface JwtPayload {
  jti: string;
  userId: string;
  email: string;
  exp?: number;
}

/* ── Express Extension ───────────────────────────── */

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}
