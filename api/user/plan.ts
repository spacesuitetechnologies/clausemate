import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// ── Inline types (mirrors client/src/lib/credits.ts) ─────────────────────────
type PlanId = "free" | "starter" | "professional" | "enterprise";

interface UserPlan {
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

const PLAN_NAMES: Record<PlanId, string> = {
  free: "Free",
  starter: "Starter",
  professional: "Professional",
  enterprise: "Enterprise",
};

// ── Env & singleton clients ───────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const anonClient = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

const serviceClient = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const FREE_PLAN: UserPlan = {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  if (!anonClient || !serviceClient) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = (req.headers?.authorization as string) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing authorization token" });
  }

  let userId: string;
  try {
    const { data, error: authError } = await anonClient.auth.getUser(token);
    if (authError || !data?.user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    userId = data.user.id;
  } catch {
    return res.status(401).json({ error: "Authentication failed" });
  }

  // ── Fetch user plan ───────────────────────────────────────────────────────
  try {
    const { data, error } = await serviceClient
      .from("user_plans")
      .select("plan_id, plan_name, credits_total, credits_used, credits_remaining, overage_credits, overage_cost, can_redline, can_rewrite")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      // Table may not exist yet — return free plan default
      console.warn("[user/plan] Query error:", error.message);
      return res.status(200).json(FREE_PLAN);
    }

    if (!data) {
      // No plan row yet — user is on free tier
      return res.status(200).json(FREE_PLAN);
    }

    const planId = (data.plan_id ?? "free") as PlanId;

    const userPlan: UserPlan = {
      plan_id: planId,
      plan_name: data.plan_name ?? PLAN_NAMES[planId] ?? "Free",
      credits_total: Number(data.credits_total ?? FREE_PLAN.credits_total),
      credits_used: Number(data.credits_used ?? 0),
      credits_remaining: Number(data.credits_remaining ?? FREE_PLAN.credits_remaining),
      overage_credits: Number(data.overage_credits ?? 0),
      overage_cost: Number(data.overage_cost ?? 0),
      can_redline: Boolean(data.can_redline ?? planId !== "free"),
      can_rewrite: Boolean(data.can_rewrite ?? (planId === "professional" || planId === "enterprise")),
    };

    return res.status(200).json(userPlan);
  } catch (err: unknown) {
    console.error("[user/plan] Unexpected error:", err instanceof Error ? err.message : err);
    return res.status(200).json(FREE_PLAN);
  }
}
