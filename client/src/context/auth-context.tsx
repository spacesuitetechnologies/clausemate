import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { useQueryClient } from "@tanstack/react-query";
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
  signup: (email: string, password: string) => Promise<void>;
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

function sessionToUser(session: Session | null): AuthUser | null {
  if (!session?.user) return null;
  const { email, user_metadata } = session.user;
  return {
    email: email ?? "",
    name: user_metadata?.full_name ?? user_metadata?.name ?? email ?? "",
  };
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Restore session on mount, then listen for auth state changes.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(sessionToUser(session));
      setIsInitializing(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(sessionToUser(session));
        if (!session) queryClient.clear();
      },
    );

    return () => subscription.unsubscribe();
  }, [queryClient]);

  const isAuthenticated = !!user;

  // Plan data is served from the backend when available.
  // Until a backend is connected, the free-tier default is used.
  const [userPlan] = useState<UserPlan>(defaultPlan);

  const refreshCredits = useCallback(async () => {
    // no-op until backend plan endpoint is wired up
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setIsAuthLoading(true);
    setAuthError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Login failed. Please try again.";
      setAuthError(message);
      throw err;
    } finally {
      setIsAuthLoading(false);
    }
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    setIsAuthLoading(true);
    setAuthError(null);
    try {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Sign up failed. Please try again.";
      setAuthError(message);
      throw err;
    } finally {
      setIsAuthLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    setAuthError(null);
  }, []);

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
        signup,
        logout,
        userPlan,
        refreshCredits,
        upgradePlan: upgradePlanFn,
        consumeCredits,
        estimateCost,
        checkAffordability,
        isLoading: isAuthLoading,
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
