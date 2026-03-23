/**
 * useCredits — convenience hook for credit-related operations.
 *
 * Wraps auth context with derived state and guard helpers.
 */

import { useMemo } from "react";
import { useAuth } from "@/context/auth-context";
import { CREDIT_COSTS, formatCredits, formatPrice, getPlan } from "@/lib/credits";

export function useCredits() {
  const {
    userPlan,
    refreshCredits,
    consumeCredits,
    estimateCost,
    checkAffordability,
    upgradePlan,
    isLoading,
  } = useAuth();

  const derived = useMemo(() => {
    const plan = getPlan(userPlan.plan_id);
    const usagePercent =
      userPlan.credits_total > 0
        ? Math.min(100, (userPlan.credits_used / userPlan.credits_total) * 100)
        : 0;
    const isOverLimit =
      userPlan.plan_id === "free" && userPlan.credits_remaining <= 0;
    const hasOverage = userPlan.overage_credits > 0;

    return {
      ...userPlan,
      plan,
      usagePercent,
      isOverLimit,
      hasOverage,
      displayRemaining: formatCredits(userPlan.credits_remaining),
      displayUsed: formatCredits(userPlan.credits_used),
      displayTotal: formatCredits(userPlan.credits_total),
      displayOverageCost: formatPrice(userPlan.overage_cost),
      overageRate: formatPrice(plan.overage_rate),
    };
  }, [userPlan]);

  return {
    ...derived,
    refreshCredits,
    consumeCredits,
    estimateCost,
    checkAffordability,
    upgradePlan,
    isLoading,
    CREDIT_COSTS,
  };
}
