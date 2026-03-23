/**
 * Credit-Based Pricing System — Types, Constants, Utilities
 *
 * Central source of truth for the credit model.
 * All pricing UI, guards, and API calls reference this file.
 */

/* ── Plan Types ──────────────────────────────────── */

export type PlanId = "free" | "starter" | "professional" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  monthly_price: number;
  credits: number;
  overage_rate: number; // ₹ per extra credit
  features: string[];
  cta: string;
  popular: boolean;
}

/* ── Usage Types ─────────────────────────────────── */

export interface CreditUsage {
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

/* ── User Plan State ─────────────────────────────── */

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

/* ── Credit Cost Constants ───────────────────────── */

export const CREDIT_COSTS = {
  /** Base contract analysis: 8–12 credits depending on length */
  ANALYSIS_MIN: 8,
  ANALYSIS_MAX: 12,
  ANALYSIS_DEFAULT: 10,
  /** Per-clause redline suggestion */
  REDLINE: 2,
  /** Full clause rewrite */
  REWRITE: 5,
} as const;

/* ── Plan Definitions ────────────────────────────── */

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    monthly_price: 0,
    credits: 10,
    overage_rate: 0, // no overage allowed
    features: [
      "1 contract (basic analysis only)",
      "10 credits included",
      "No redlines or rewrites",
      "Email support",
    ],
    cta: "Get Started",
    popular: false,
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
    cta: "Choose Starter",
    popular: false,
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
    cta: "Start Professional",
    popular: true,
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
    cta: "Contact Sales",
    popular: false,
  },
];

export function getPlan(id: PlanId): Plan {
  return PLANS.find((p) => p.id === id) || PLANS[0];
}

/* ── Credit Estimation ───────────────────────────── */

/**
 * Estimate credits for an analysis before running it.
 * pageCount approximates document complexity.
 */
export function estimateAnalysisCost(
  pageCount: number = 1,
  includeRedlines: boolean = false,
  clauseCount: number = 6
): AnalysisCost {
  const analysisCost = Math.min(
    CREDIT_COSTS.ANALYSIS_MAX,
    Math.max(CREDIT_COSTS.ANALYSIS_MIN, CREDIT_COSTS.ANALYSIS_MIN + pageCount)
  );

  const breakdown: CreditBreakdownItem[] = [
    { action: "analysis", label: "Contract analysis", credits: analysisCost },
  ];

  let total = analysisCost;

  if (includeRedlines) {
    const redlineCost = clauseCount * CREDIT_COSTS.REDLINE;
    breakdown.push({
      action: "redline",
      label: `Redline suggestions (${clauseCount} clauses)`,
      credits: redlineCost,
    });
    total += redlineCost;
  }

  return {
    estimated_credits: total,
    actual_credits: 0, // filled after analysis completes
    breakdown,
  };
}

/**
 * Check if the user can afford the estimated cost.
 */
export function canAfford(
  userPlan: UserPlan,
  estimatedCredits: number
): { allowed: boolean; reason?: string } {
  if (userPlan.plan_id === "free" && userPlan.credits_remaining <= 0) {
    return { allowed: false, reason: "Free plan limit reached. Upgrade to continue." };
  }

  // Paid plans allow overage
  if (userPlan.plan_id !== "free") {
    return { allowed: true };
  }

  if (userPlan.credits_remaining < estimatedCredits) {
    return {
      allowed: false,
      reason: `Insufficient credits. Need ~${estimatedCredits}, have ${userPlan.credits_remaining}.`,
    };
  }

  return { allowed: true };
}

/**
 * Format credits as display string.
 */
export function formatCredits(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

/**
 * Format price with ₹ symbol.
 */
export function formatPrice(amount: number): string {
  if (amount === 0) return "₹0";
  return `₹${amount.toLocaleString("en-IN")}`;
}
