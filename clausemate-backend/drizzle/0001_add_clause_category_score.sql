-- Migration: add category and score columns to clauses table
-- Run via: npm run db:migrate  (or apply manually if using db:push)

ALTER TABLE "clauses"
  ADD COLUMN IF NOT EXISTS "category" text NOT NULL DEFAULT 'general';

ALTER TABLE "clauses"
  ADD COLUMN IF NOT EXISTS "score" integer NOT NULL DEFAULT 0;

-- Backfill existing rows (score stays 0, category stays 'general' — acceptable for historical data)
