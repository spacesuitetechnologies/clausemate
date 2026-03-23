-- Prevent duplicate clause rows on worker retry.
--
-- Without this constraint, a BullMQ retry after step 10 re-inserts every
-- clause, doubling (or more) the rows for that analysis. The worker now does
-- a DELETE-before-INSERT in step 10, but the DB constraint is the safety net:
-- even if a bug bypasses the delete, the INSERT will fail loudly rather than
-- silently producing duplicate data.
ALTER TABLE clauses
  ADD CONSTRAINT clauses_analysis_clause_unique UNIQUE (analysis_id, clause_number);
