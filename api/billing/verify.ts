/**
 * POST /api/billing/verify
 *
 * Verifies a Razorpay payment signature after checkout completes.
 * Called by the frontend's Razorpay handler callback.
 *
 * This only verifies the signature — credit allocation is handled by
 * the Razorpay webhook (POST /api/billing/webhook) which fires on
 * invoice.paid events.
 *
 * Required env vars:
 *   RAZORPAY_KEY_SECRET
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac } from "node:crypto";
import { getUserIdFromToken } from "../../lib/server/supabase";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = (req.headers?.authorization as string) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  try {
    await getUserIdFromToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payment_id = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
  const subscription_id =
    typeof body.razorpay_subscription_id === "string" ? body.razorpay_subscription_id : "";
  const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";

  if (!payment_id || !subscription_id || !signature) {
    return res.status(400).json({ error: "razorpay_payment_id, razorpay_subscription_id, and razorpay_signature are required" });
  }

  // ── Verify signature ──────────────────────────────────────────────────────
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    console.error("[billing/verify] Missing RAZORPAY_KEY_SECRET");
    return res.status(500).json({ error: "Payment system not configured" });
  }

  try {
    const payload = `${payment_id}|${subscription_id}`;
    const expected = createHmac("sha256", keySecret).update(payload).digest("hex");

    if (expected !== signature) {
      console.warn("[billing/verify] Signature mismatch for payment:", payment_id);
      return res.status(400).json({ error: "Payment verification failed" });
    }

    // Signature valid — credit allocation happens via webhook (invoice.paid)
    console.log("[billing/verify] Payment verified:", payment_id);
    return res.status(200).json({ verified: true, status: "active" });
  } catch (err: unknown) {
    console.error("[billing/verify] Error:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Verification failed. Please contact support." });
  }
}
