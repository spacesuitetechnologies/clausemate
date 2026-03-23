-- Add credits_reserved to credit_usage for atomic credit reservation.
--
-- credits_reserved holds the sum of credits locked by in-progress analyses
-- that have been queued but not yet completed or failed. This prevents the
-- TOCTOU race where multiple concurrent analyses all pass checkBalance()
-- before any worker has had a chance to deduct credits.
--
-- Effective available credits = plan.credits - credits_used - credits_reserved

ALTER TABLE credit_usage
  ADD COLUMN IF NOT EXISTS credits_reserved INTEGER NOT NULL DEFAULT 0;
