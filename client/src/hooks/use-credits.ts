/**
 * useCredits — convenience hook for credit-related operations.
 *
 * Wraps auth context with derived state and guard helpers.
 * UI-facing values use contracts (outcome-based); credits remain internal.
 */

import { useMemo } from "react";
import { useAuth } from "@/context/auth-context";
import {
  CREDIT_COSTS,
  PAYG_OPTIONS,
  creditsToContracts,
  formatCredits,
  formatPrice,
  getPlan,
} from "@/lib/credits";

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

    // Credit-based (internal)
    const usagePercent =
      userPlan.credits_total > 0
        ? Math.min(100, (userPlan.credits_used / userPlan.credits_total) * 100)
        : 0;
    const isOverLimit =
      userPlan.plan_id === "free" && userPlan.credits_remaining <= 0;
    const hasOverage = userPlan.overage_credits > 0;

    // Contract-based (display)
    const contractsTotal = plan.contracts_per_month;
    const contractsUsed = creditsToContracts(userPlan.credits_used);
    const contractsRemaining = Math.max(0, contractsTotal - contractsUsed);
    const contractsPercent =
      contractsTotal > 0 ? Math.min(100, (contractsUsed / contractsTotal) * 100) : 0;

    return {
      ...userPlan,
      plan,
      // credit-facing (still used for internal guards)
      usagePercent,
      isOverLimit,
      hasOverage,
      displayRemaining: formatCredits(userPlan.credits_remaining),
      displayUsed: formatCredits(userPlan.credits_used),
      displayTotal: formatCredits(userPlan.credits_total),
      displayOverageCost: formatPrice(userPlan.overage_cost),
      overageRate: formatPrice(plan.overage_rate),
      // contract-facing (used in UI)
      contractsTotal,
      contractsUsed,
      contractsRemaining,
      contractsPercent,
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
    PAYG_OPTIONS,
  };
}
