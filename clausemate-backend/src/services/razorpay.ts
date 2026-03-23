import Razorpay from "razorpay";
import crypto from "crypto";
import { config } from "../config";

/* ── Singleton Instance ───────────────────────────── */

let _instance: Razorpay | null = null;

export function getRazorpay(): Razorpay {
  if (!config.razorpay.keyId || !config.razorpay.keySecret) {
    throw new Error(
      "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables."
    );
  }
  if (!_instance) {
    _instance = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
  }
  return _instance;
}

export function isRazorpayConfigured(): boolean {
  return !!(config.razorpay.keyId && config.razorpay.keySecret && config.razorpay.webhookSecret);
}

/* ── Signature Verification ───────────────────────── */

/**
 * Verifies an incoming Razorpay webhook signature.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  if (!config.razorpay.webhookSecret) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET is not configured");
  }
  const expectedHex = crypto
    .createHmac("sha256", config.razorpay.webhookSecret)
    .update(rawBody)
    .digest("hex");

  // Both hex strings from SHA-256 are always 64 chars — safe for timingSafeEqual
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedHex, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Verifies the payment signature returned by Razorpay Checkout.
 * Called from POST /billing/verify.
 */
export function verifyPaymentSignature(
  paymentId: string,
  subscriptionId: string,
  signature: string
): boolean {
  if (!config.razorpay.keySecret) return false;
  const data = `${paymentId}|${subscriptionId}`;
  const expectedHex = crypto
    .createHmac("sha256", config.razorpay.keySecret)
    .update(data)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedHex, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

/* ── Plan ID Lookup ───────────────────────────────── */

export function getRazorpayPlanId(planId: "starter" | "professional" | "enterprise"): string {
  const id = config.razorpay.planIds[planId];
  if (!id) {
    throw new Error(`Razorpay plan ID not configured for plan: ${planId}. Set RAZORPAY_PLAN_ID_${planId.toUpperCase()}`);
  }
  return id;
}
