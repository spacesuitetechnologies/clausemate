-- Prevent duplicate in-flight analyses for the same contract.
--
-- The in-flight check in POST /analyze is a non-locking read. Two concurrent
-- requests can both see no in-progress analysis and both proceed to reserve
-- credits and insert analysis rows — charging the user twice.
--
-- This partial unique index makes the second INSERT fail with 23505, which
-- the route handler catches: it releases the reservation and returns 409.
-- Historical completed/failed rows are excluded so legitimate retries
-- (user re-submits after a failure) are never blocked.
CREATE UNIQUE INDEX analyses_one_inflight_per_contract_idx
  ON analyses (user_id, contract_id)
  WHERE status IN ('queued', 'processing');
