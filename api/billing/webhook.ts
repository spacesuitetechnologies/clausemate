/**
 * POST /api/billing/webhook
 *
 * Razorpay webhook handler. Processes subscription events and allocates credits.
 *
 * Idempotency: Each webhook event is recorded in `webhook_events` table.
 * Duplicate deliveries (Razorpay retries) are safely ignored.
 *
 * Required Supabase table:
 *   CREATE TABLE IF NOT EXISTS webhook_events (
 *     event_id      text PRIMARY KEY,
 *     event_type    text NOT NULL,
 *     processed_at  timestamptz DEFAULT now()
 *   );
 *
 * Required env vars:
 *   RAZORPAY_WEBHOOK_SECRET   — Webhook signature secret from Razorpay dashboard
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Credit plan mapping (configure RAZORPAY_PLAN_ID_* in env):
 *   RAZORPAY_PLAN_ID_STARTER, RAZORPAY_PLAN_ID_PROFESSIONAL, RAZORPAY_PLAN_ID_ENTERPRISE
 */

import { createHmac } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getServiceClient } from "../../lib/server/supabase";

const PLAN_CREDITS: Record<string, { credits: number; plan_id: string; plan_name: string; can_redline: boolean; can_rewrite: boolean }> = {
  starter:      { credits: 100,  plan_id: "starter",      plan_name: "Starter",      can_redline: true,  can_rewrite: false },
  professional: { credits: 400,  plan_id: "professional", plan_name: "Professional", can_redline: true,  can_rewrite: true  },
  enterprise:   { credits: 1500, plan_id: "enterprise",   plan_name: "Enterprise",   can_redline: true,  can_rewrite: true  },
};

function getPlanFromRazorpayId(razorpayPlanId: string): keyof typeof PLAN_CREDITS | null {
  for (const key of Object.keys(PLAN_CREDITS)) {
    const envVar = process.env[`RAZORPAY_PLAN_ID_${key.toUpperCase()}`];
    if (envVar && envVar === razorpayPlanId) return key;
  }
  return null;
}

async function isEventProcessed(eventId: string): Promise<boolean> {
  try {
    const { data } = await getServiceClient()
      .from("webhook_events")
      .select("event_id")
      .eq("event_id", eventId)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

async function markEventProcessed(eventId: string, eventType: string): Promise<void> {
  try {
    await getServiceClient()
      .from("webhook_events")
      .insert({ event_id: eventId, event_type: eventType });
  } catch {
    // Non-fatal — worst case: duplicate processing on retry (handled by upsert below)
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ── Signature verification ────────────────────────────────────────────────
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[webhook] Missing RAZORPAY_WEBHOOK_SECRET");
    return res.status(500).json({ error: "Webhook not configured" });
  }

  const signature = req.headers["x-razorpay-signature"] as string | undefined;
  if (!signature) {
    return res.status(400).json({ error: "Missing webhook signature" });
  }

  // Raw body must be used for signature verification
  const rawBody =
    typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body ?? {});

  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  if (expected !== signature) {
    console.warn("[webhook] Signature mismatch");
    return res.status(400).json({ error: "Invalid signature" });
  }

  // ── Parse event ───────────────────────────────────────────────────────────
  let event: Record<string, unknown>;
  try {
    event = typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  const eventId = event.id as string | undefined;
  const eventType = event.event as string | undefined;

  if (!eventId || !eventType) {
    return res.status(400).json({ error: "Missing event id or type" });
  }

  // ── Idempotency check ─────────────────────────────────────────────────────
  if (await isEventProcessed(eventId)) {
    console.log(`[webhook] Already processed: ${eventId} (${eventType})`);
    return res.status(200).json({ ok: true, skipped: true });
  }

  // ── Handle subscription.charged / invoice.paid ────────────────────────────
  const CREDIT_EVENTS = new Set([
    "subscription.charged",
    "invoice.paid",
    "payment.captured",
  ]);

  if (!CREDIT_EVENTS.has(eventType)) {
    // Acknowledge non-credit events without processing
    await markEventProcessed(eventId, eventType);
    return res.status(200).json({ ok: true, event: eventType });
  }

  try {
    // Extract subscription/plan details from event payload
    const payload = event.payload as Record<string, unknown> | undefined;
    const subscriptionEntity =
      (payload?.subscription as Record<string, unknown> | undefined)?.entity as Record<string, unknown> | undefined;
    const paymentEntity =
      (payload?.payment as Record<string, unknown> | undefined)?.entity as Record<string, unknown> | undefined;

    // Get user_id from subscription notes (set when creating subscription)
    const notes =
      subscriptionEntity?.notes as Record<string, unknown> | undefined;
    const userId = (notes?.user_id ?? paymentEntity?.notes?.user_id) as string | undefined;
    const razorpayPlanId = subscriptionEntity?.plan_id as string | undefined;

    if (!userId) {
      console.error(`[webhook] No user_id in event ${eventId}`);
      await markEventProcessed(eventId, eventType);
      return res.status(200).json({ ok: true, warning: "No user_id in notes" });
    }

    const planKey = razorpayPlanId ? getPlanFromRazorpayId(razorpayPlanId) : null;
    const planConfig = planKey ? PLAN_CREDITS[planKey] : null;

    if (!planConfig) {
      console.warn(`[webhook] Unknown plan ID: ${razorpayPlanId ?? "none"} for user ${userId}`);
      await markEventProcessed(eventId, eventType);
      return res.status(200).json({ ok: true, warning: "Unknown plan ID" });
    }

    // Upsert user plan — idempotent by nature (upsert on user_id)
    const db = getServiceClient();
    const { error: upsertError } = await db
      .from("user_plans")
      .upsert(
        {
          user_id: userId,
          plan_id: planConfig.plan_id,
          plan_name: planConfig.plan_name,
          credits_total: planConfig.credits,
          credits_used: 0,
          credits_remaining: planConfig.credits,
          overage_credits: 0,
          overage_cost: 0,
          can_redline: planConfig.can_redline,
          can_rewrite: planConfig.can_rewrite,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

    if (upsertError) {
      console.error(`[webhook] Failed to update plan for ${userId}:`, upsertError.message);
      // Do NOT mark as processed — let Razorpay retry
      return res.status(500).json({ error: "Failed to update user plan" });
    }

    await markEventProcessed(eventId, eventType);

    console.log(
      `[webhook] Credits allocated: user=${userId} plan=${planConfig.plan_id} credits=${planConfig.credits} event=${eventId}`,
    );
    return res.status(200).json({ ok: true, user_id: userId, plan: planConfig.plan_id });
  } catch (err: unknown) {
    console.error("[webhook] Fatal:", err instanceof Error ? err.message : err);
    // Return 500 so Razorpay retries — idempotency check will skip on retry
    return res.status(500).json({ error: "Internal error processing webhook" });
  }
}
