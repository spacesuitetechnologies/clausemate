import { eq, and, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { config } from "../config";

/* ── Model Pricing Table ──────────────────────────── */

/**
 * Cost per 1 million tokens in USD.
 * Keys match the model IDs used in config.llm.modelOpenai / modelAnthropic.
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o":                   { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":              { input: 0.15,  output: 0.60  },
  "gpt-4.1":                  { input: 2.00,  output: 8.00  },
  "claude-sonnet-4-20250514": { input: 3.00,  output: 15.00 },
  "claude-opus-4-5":          { input: 15.00, output: 75.00 },
  "claude-haiku-4-5-20251001":{ input: 0.80,  output: 4.00  },
};

// Fallback pricing used when the exact model isn't in the table.
const DEFAULT_PRICING = { input: 3.00, output: 15.00 };

/* ── Token Estimation ─────────────────────────────── */

/**
 * Character-based token approximation (~4 chars per token).
 * Used for pre-flight checks before making the actual API call.
 */
export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/* ── Contract Size Guard ──────────────────────────── */

/**
 * Checks whether the extracted contract text would exceed the configured
 * input-token ceiling before spinning up the LLM pipeline.
 *
 * Returns `ok: false` with the estimated token count when the contract
 * would be rejected so the caller can surface a meaningful error message.
 */
export function checkContractSize(contractText: string): {
  ok: boolean;
  estimatedTokens: number;
} {
  const estimatedTokens = estimateInputTokens(contractText);
  return {
    ok: estimatedTokens <= config.llm.maxInputTokens,
    estimatedTokens,
  };
}

/* ── Monthly Token Cap ────────────────────────────── */

/**
 * Looks up the active billing period's LLM token usage for the given user
 * and compares it against the configured monthly ceiling.
 *
 * The check is advisory (not transactional) — a small window exists where
 * concurrent submissions could both pass. The ceiling is a cost guardrail,
 * not a hard financial limit, so this trade-off is acceptable.
 */
export async function checkMonthlyTokenCap(userId: string): Promise<{
  ok: boolean;
  used: number;
  cap: number;
}> {
  const cap = config.llm.maxMonthlyTokensPerUser;

  const [usage] = await db
    .select({ llmTokensUsed: schema.creditUsage.llmTokensUsed })
    .from(schema.creditUsage)
    .innerJoin(
      schema.subscriptions,
      eq(schema.creditUsage.subscriptionId, schema.subscriptions.id)
    )
    .where(
      and(
        eq(schema.creditUsage.userId, userId),
        eq(schema.subscriptions.status, "active")
      )
    )
    .limit(1);

  const used = usage?.llmTokensUsed ?? 0;
  return { ok: used < cap, used, cap };
}

/* ── Cost Calculation ─────────────────────────────── */

/**
 * Computes the USD cost for a completed LLM call given the actual token counts
 * returned by the provider.
 */
export function calcLlmCostUsd(
  inputTokens: number,
  outputTokens: number,
  modelName: string
): number {
  const pricing = MODEL_PRICING[modelName] ?? DEFAULT_PRICING;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/* ── Token Accumulation ───────────────────────────── */

/**
 * Atomically adds `totalTokens` to the `llm_tokens_used` counter for the
 * billing period row identified by `subscriptionId`.
 *
 * Called once per analysis after all LLM calls complete. Using a SQL
 * expression (`llm_tokens_used + N`) avoids a read-modify-write race
 * when two analyses finish concurrently for the same user.
 */
export async function accumulateTokens(
  subscriptionId: string,
  totalTokens: number
): Promise<void> {
  if (totalTokens <= 0) return;

  await db
    .update(schema.creditUsage)
    .set({ llmTokensUsed: sql`llm_tokens_used + ${totalTokens}` })
    .where(eq(schema.creditUsage.subscriptionId, subscriptionId));
}
