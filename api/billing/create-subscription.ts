/**
 * POST /api/billing/create-subscription
 *
 * Creates a Razorpay subscription for the given plan and returns the details
 * needed to open the Razorpay checkout modal on the frontend.
 *
 * Required env vars:
 *   RAZORPAY_KEY_ID            — Razorpay public key
 *   RAZORPAY_KEY_SECRET        — Razorpay secret key
 *   RAZORPAY_PLAN_ID_STARTER   — Razorpay plan ID for Starter tier
 *   RAZORPAY_PLAN_ID_PROFESSIONAL
 *   RAZORPAY_PLAN_ID_ENTERPRISE
 *
 * Also requires SUPABASE_* vars for auth verification.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getUserIdFromToken } from "../../lib/server/supabase";

const PLAN_PRICES: Record<string, number> = {
  starter: 999,
  professional: 2999,
  enterprise: 9999,
};

const PLAN_NAMES: Record<string, string> = {
  starter: "Starter",
  professional: "Professional",
  enterprise: "Enterprise",
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = (req.headers?.authorization as string) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  let userId: string;
  try {
    userId = await getUserIdFromToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  const body = (req.body ?? {}) as Record<string, unknown>;
  const plan_id = typeof body.plan_id === "string" ? body.plan_id.toLowerCase() : "";

  if (!["starter", "professional", "enterprise"].includes(plan_id)) {
    return res.status(400).json({ error: "plan_id must be starter, professional, or enterprise" });
  }

  // ── Env ───────────────────────────────────────────────────────────────────
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const razorpayPlanId =
    process.env[`RAZORPAY_PLAN_ID_${plan_id.toUpperCase()}`];

  if (!keyId || !keySecret) {
    console.error("[billing/create-subscription] Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET");
    return res.status(500).json({ error: "Payment system not configured" });
  }

  if (!razorpayPlanId) {
    console.error(`[billing/create-subscription] Missing RAZORPAY_PLAN_ID_${plan_id.toUpperCase()}`);
    return res.status(500).json({ error: "Plan not configured" });
  }

  // ── Create Razorpay subscription ──────────────────────────────────────────
  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    const r = await fetch("https://api.razorpay.com/v1/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plan_id: razorpayPlanId,
        quantity: 1,
        total_count: 12, // 12 billing cycles (1 year)
        notes: {
          user_id: userId,
          plan: plan_id,
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: { description?: string } };
      const message = err?.error?.description ?? `Razorpay error ${r.status}`;
      console.error("[billing/create-subscription] Razorpay error:", message);
      return res.status(502).json({ error: "Could not create subscription. Please try again." });
    }

    const sub = await r.json() as { id: string };

    return res.status(200).json({
      subscription_id: sub.id,
      key_id: keyId,
      plan_id,
      plan_name: PLAN_NAMES[plan_id],
      monthly_price: PLAN_PRICES[plan_id],
    });
  } catch (err: unknown) {
    console.error("[billing/create-subscription] Fatal:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Could not initiate payment. Please try again." });
  }
}
