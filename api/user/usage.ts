/**
 * GET /api/user/usage
 *
 * Returns credit usage for the current billing period.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getUserIdFromToken, getServiceClient } from "../../lib/server/supabase";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const authHeader = (req.headers?.authorization as string) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  let userId: string;
  try {
    userId = await getUserIdFromToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  try {
    const db = getServiceClient();
    const { data, error } = await db
      .from("user_plans")
      .select("credits_total, credits_used, credits_remaining, overage_credits, overage_cost")
      .eq("user_id", userId)
      .maybeSingle();

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

    if (error || !data) {
      return res.status(200).json({
        credits_used: 0,
        credits_remaining: 10,
        credits_total: 10,
        overage_credits: 0,
        overage_cost: 0,
        period_start: periodStart,
        period_end: periodEnd,
      });
    }

    return res.status(200).json({
      credits_used: data.credits_used ?? 0,
      credits_remaining: data.credits_remaining ?? 10,
      credits_total: data.credits_total ?? 10,
      overage_credits: data.overage_credits ?? 0,
      overage_cost: data.overage_cost ?? 0,
      period_start: periodStart,
      period_end: periodEnd,
    });
  } catch (err: unknown) {
    console.error("[user/usage] Error:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Could not retrieve usage." });
  }
}
