-- Add Razorpay customer ID to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "razorpay_customer_id" text;

-- Add Razorpay fields to subscriptions
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "razorpay_subscription_id" text;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "last_invoice_id" text;

-- Index on razorpay_subscription_id for fast webhook lookups
CREATE INDEX IF NOT EXISTS "subscriptions_razorpay_idx" ON "subscriptions" ("razorpay_subscription_id");

-- Webhook events table for idempotency
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id" text NOT NULL UNIQUE,
  "event_type" text NOT NULL,
  "processed_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webhook_events_event_id_idx" ON "webhook_events" ("event_id");
