import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserPlan, PlanId, AnalysisCost } from "@/lib/credits";
import { estimateAnalysisCost, canAfford } from "@/lib/credits";
import * as api from "@/lib/api";

interface AuthUser {
  name: string;
  email: string;
}

interface AuthContextType {
  // Auth
  user: AuthUser | null;
  isAuthenticated: boolean;
  isInitializing: boolean;
  authError: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;

  // Credits
  userPlan: UserPlan;
  refreshCredits: () => Promise<void>;
  upgradePlan: (planId: PlanId) => Promise<void>;
  consumeCredits: (
    contractId: string,
    includeRedlines?: boolean,
    clauseCount?: number,
  ) => Promise<AnalysisCost>;
  estimateCost: (
    pageCount?: number,
    includeRedlines?: boolean,
    clauseCount?: number,
  ) => ReturnType<typeof estimateAnalysisCost>;
  checkAffordability: (
    estimatedCredits: number,
  ) => { allowed: boolean; reason?: string };
  isLoading: boolean;
}

const defaultPlan: UserPlan = {
  plan_id: "free",
  plan_name: "Free",
  credits_total: 10,
  credits_used: 0,
  credits_remaining: 10,
  overage_credits: 0,
  overage_cost: 0,
  can_redline: false,
  can_rewrite: false,
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Restore session from httpOnly cookie on mount — if the cookie is valid
  // the server returns the user profile; a 401 means no active session.
  useEffect(() => {
    api
      .fetchUserMe()
      .then((me) => setUser({ name: me.name, email: me.email }))
      .catch(() => {}) // 401 = not logged in, local state stays null
      .finally(() => setIsInitializing(false));
  }, []);

  // User plan via React Query — only active when authenticated
  const isAuthenticated = !!user;
  const {
    data: userPlan = defaultPlan,
    isLoading: planLoading,
    refetch: refetchPlan,
  } = useQuery({
    queryKey: ["user", "plan"],
    queryFn: api.fetchUserPlan,
    enabled: isAuthenticated,
    staleTime: 30_000,
  });

  const refreshCredits = useCallback(async () => {
    await refetchPlan();
  }, [refetchPlan]);

  const login = useCallback(
    async (email: string, password: string) => {
      setIsAuthLoading(true);
      setAuthError(null);
      try {
        const { user: u } = await api.loginUser(email, password);
        setUser({ name: u.name, email: u.email });
        // Prime plan cache immediately after login
        queryClient.invalidateQueries({ queryKey: ["user", "plan"] });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Login failed. Please try again.";
        setAuthError(message);
        throw err;
      } finally {
        setIsAuthLoading(false);
      }
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api.logoutUser();
    } catch {
      // Clear local state regardless of server response
    }
    setUser(null);
    setAuthError(null);
    queryClient.clear();
  }, [queryClient]);

  /**
   * upgradePlan — initiates the Razorpay subscription checkout flow.
   *
   * Flow: createSubscription → load Razorpay.js → open checkout
   *       → verifyPayment signature → webhook allocates credits.
   *
   * Direct plan mutation via POST /user/plan has been removed.
   * Credits are ONLY allocated by the webhook (invoice.paid).
   */
  const upgradePlanFn = useCallback(
    async (planId: PlanId) => {
      if (planId === "free") {
        throw new Error(
          "Downgrading to the free plan requires contacting support.",
        );
      }

      const tier = planId as "starter" | "professional" | "enterprise";

      // ── Mock mode: update query cache directly (no real payment) ──────────
      if (api.USE_MOCK) {
        const { getPlan } = await import("@/lib/credits");
        const plan = getPlan(planId);
        const mockUpdated: UserPlan = {
          plan_id: planId,
          plan_name: plan.name,
          credits_total: plan.credits,
          credits_used: 0,
          credits_remaining: plan.credits,
          overage_credits: 0,
          overage_cost: 0,
          can_redline: planId !== "free",
          can_rewrite: planId === "professional" || planId === "enterprise",
        };
        queryClient.setQueryData(["user", "plan"], mockUpdated);
        return;
      }

      // ── Real mode: Razorpay checkout ────────────────────────────────────
      const subData = await api.createSubscription(tier);

      // Load Razorpay Checkout.js script if not already present
      await new Promise<void>((resolve, reject) => {
        if ((window as { Razorpay?: unknown }).Razorpay) {
          resolve();
          return;
        }
        const script = document.createElement("script");
        script.src = "https://checkout.razorpay.com/v1/checkout.js";
        script.onload = () => resolve();
        script.onerror = () =>
          reject(new Error("Failed to load payment gateway. Check your connection."));
        document.body.appendChild(script);
      });

      // Open checkout and wait for payment result
      await new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rzp = new (window as any).Razorpay({
          key: subData.key_id,
          subscription_id: subData.subscription_id,
          name: "Clausemate",
          description: `${subData.plan_name} Plan — monthly`,
          handler: async (response: {
            razorpay_payment_id: string;
            razorpay_subscription_id: string;
            razorpay_signature: string;
          }) => {
            try {
              await api.verifyPayment({
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_subscription_id: response.razorpay_subscription_id,
                razorpay_signature: response.razorpay_signature,
              });
              // Webhook will allocate credits asynchronously.
              // Refresh plan after a short delay to pick up the activated state.
              setTimeout(() => {
                queryClient.invalidateQueries({ queryKey: ["user", "plan"] });
              }, 3000);
              resolve();
            } catch (err) {
              reject(err);
            }
          },
          modal: {
            ondismiss: () => reject(new Error("Payment cancelled.")),
          },
          theme: { color: "#6366f1" },
        });
        rzp.open();
      });
    },
    [queryClient],
  );

  /**
   * consumeCredits — starts analysis and returns cost breakdown.
   * Credit balance is NOT refreshed here; useAnalysisPolling does it
   * via queryClient.invalidateQueries when status === "completed".
   */
  const consumeCredits = useCallback(
    async (
      contractId: string,
      includeRedlines = false,
      clauseCount = 6,
    ): Promise<AnalysisCost> => {
      const result = await api.startAnalysis(contractId, includeRedlines, clauseCount);
      return {
        estimated_credits: result.estimated_credits,
        actual_credits: result.actual_credits,
        breakdown: result.breakdown,
      };
    },
    [],
  );

  const estimateCost = useCallback(
    (pageCount = 1, includeRedlines = false, clauseCount = 6) =>
      estimateAnalysisCost(pageCount, includeRedlines, clauseCount),
    [],
  );

  const checkAffordability = useCallback(
    (estimatedCredits: number) => canAfford(userPlan, estimatedCredits),
    [userPlan],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isInitializing,
        authError,
        login,
        logout,
        userPlan,
        refreshCredits,
        upgradePlan: upgradePlanFn,
        consumeCredits,
        estimateCost,
        checkAffordability,
        isLoading: isAuthLoading || planLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
