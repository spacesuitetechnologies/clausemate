/**
 * Credit-Based Pricing System — Types, Constants, Utilities
 *
 * Central source of truth for the credit model.
 * Credits are used internally for cost control.
 * UI displays contracts_per_month instead of raw credits.
 */

/* ── Plan Types ──────────────────────────────────── */

export type PlanId = "free" | "starter" | "professional" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  monthly_price: number;
  credits: number;
  /** Display-facing contract quota — shown in UI instead of raw credits */
  contracts_per_month: number;
  /** ₹ per contract equivalent shown in UI for value framing */
  price_per_contract: number;
  overage_rate: number; // ₹ per extra credit
  /** One-line positioning tagline */
  tagline: string;
  /** Short depth-of-analysis description */
  analysis_depth: string;
  features: string[];
  cta: string;
  popular: boolean;
  badge?: string;
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
    contracts_per_month: 3,
    price_per_contract: 0,
    overage_rate: 0,
    tagline: "Try before you commit",
    analysis_depth: "Basic risk flags only",
    features: [
      "3 contracts / month",
      "Basic risk flags only",
      "No redlines or rewrites",
      "Email support",
    ],
    cta: "Get Started Free",
    popular: false,
  },
  {
    id: "starter",
    name: "Starter",
    monthly_price: 999,
    credits: 100,
    contracts_per_month: 20,
    price_per_contract: 50,
    overage_rate: 15,
    tagline: "Perfect for occasional reviews",
    analysis_depth: "Limited clause insights",
    features: [
      "20 contracts / month",
      "Limited clause insights",
      "Basic analysis + limited redlines",
      "Email support",
    ],
    cta: "Start Analyzing",
    popular: false,
  },
  {
    id: "professional",
    name: "Professional",
    monthly_price: 2999,
    credits: 400,
    contracts_per_month: 100,
    price_per_contract: 30,
    overage_rate: 12,
    tagline: "Best for founders & startups",
    analysis_depth: "Full legal-grade analysis + redlines",
    features: [
      "100 contracts / month",
      "Full legal-grade analysis + redlines",
      "AI-drafted clause rewrites",
      "Priority processing & support",
    ],
    cta: "Get Full Protection",
    popular: true,
    badge: "Most Popular",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthly_price: 9999,
    credits: 1500,
    contracts_per_month: 500,
    price_per_contract: 20,
    overage_rate: 8,
    tagline: "For scaling legal teams",
    analysis_depth: "Team workflows + bulk processing",
    features: [
      "500 contracts / month",
      "Team workflows + bulk processing",
      "Full features + API access",
      "Dedicated account manager",
    ],
    cta: "Scale Your Team",
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
    return { allowed: false, reason: "You've reached your contract limit. Upgrade to analyze more." };
  }

  // Paid plans allow overage
  if (userPlan.plan_id !== "free") {
    return { allowed: true };
  }

  if (userPlan.credits_remaining < estimatedCredits) {
    return {
      allowed: false,
      reason: "No contracts remaining this month. Upgrade or buy extra contracts.",
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

/**
 * Convert a credit count to an approximate contract count for display.
 * Uses ANALYSIS_DEFAULT as the per-contract credit cost.
 */
export function creditsToContracts(credits: number): number {
  return Math.floor(credits / CREDIT_COSTS.ANALYSIS_DEFAULT);
}

/**
 * Pay-as-you-go top-up options displayed below the plan grid.
 * Contracts → price mapping only; backend records these as credit additions.
 */
export const PAYG_OPTIONS = [
  { contracts: 5,  price: 99,  label: "5 contracts" },
  { contracts: 12, price: 199, label: "12 contracts" },
] as const;
