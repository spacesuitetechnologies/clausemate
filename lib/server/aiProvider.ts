/**
 * AI Provider abstraction layer.
 *
 * - Provider selection via AI_PROVIDER env var ("anthropic" | "openai")
 * - Automatic fallback to secondary provider
 * - Retry with backoff (max 2 retries per provider)
 * - Token usage tracking + cost estimation
 * - Structured logging throughout
 */

import { log, warn, err as logErr } from "./logger";
import type { LLMUsage } from "./types";

const CALL_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = [1_000, 2_000];

// Published pricing (USD per 1M tokens) — update as providers change rates
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.25,  output: 1.25  },
  "gpt-4o-mini":                { input: 0.15,  output: 0.60  },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model] ?? { input: 0.5, output: 1.5 };
  return Math.round(
    ((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * 100_000,
  ) / 100_000;
}

export type ProviderName = "anthropic" | "openai";

export interface CallOptions {
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}

export interface ProviderResult {
  text: string;
  provider: ProviderName;
  usage: LLMUsage;
}

// ── Abort helper ──────────────────────────────────────────────────────────────

function makeAbortSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function isNonRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Timeouts and auth errors — no point retrying
  if (err.name === "AbortError") return true;
  if (/401|403|invalid.api.key/i.test(err.message)) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Provider implementations ──────────────────────────────────────────────────

interface RawResult { text: string; usage: LLMUsage }

async function callAnthropic(prompt: string, opts: CallOptions): Promise<RawResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const model = "claude-haiku-4-5-20251001";
  const { signal, clear } = makeAbortSignal(opts.timeoutMs ?? CALL_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 2048,
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });
    clear();

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Anthropic ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    if (!text) throw new Error("Anthropic returned empty content");

    const inputTokens  = data.usage?.input_tokens  ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;

    return {
      text,
      usage: {
        provider: "anthropic",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: estimateCost(model, inputTokens, outputTokens),
      },
    };
  } catch (e) {
    clear();
    throw e;
  }
}

async function callOpenAI(prompt: string, opts: CallOptions): Promise<RawResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const model = "gpt-4o-mini";
  const { signal, clear } = makeAbortSignal(opts.timeoutMs ?? CALL_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 2048,
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });
    clear();

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenAI ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("OpenAI returned empty content");

    const inputTokens  = data.usage?.prompt_tokens     ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;

    return {
      text,
      usage: {
        provider: "openai",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: estimateCost(model, inputTokens, outputTokens),
      },
    };
  } catch (e) {
    clear();
    throw e;
  }
}

// ── Provider order ────────────────────────────────────────────────────────────

function resolveOrder(): ProviderName[] {
  const preferred = (process.env.AI_PROVIDER ?? "").toLowerCase().trim();
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI    = !!process.env.OPENAI_API_KEY;

  if (preferred === "openai") {
    return ([hasOpenAI && "openai", hasAnthropic && "anthropic"] as (ProviderName | false)[])
      .filter(Boolean) as ProviderName[];
  }
  return ([hasAnthropic && "anthropic", hasOpenAI && "openai"] as (ProviderName | false)[])
    .filter(Boolean) as ProviderName[];
}

// ── Retry per provider ────────────────────────────────────────────────────────

async function callWithRetry(
  provider: ProviderName,
  prompt: string,
  opts: CallOptions,
): Promise<RawResult> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAY_MS[attempt - 1] ?? 2_000;
      warn("aiProvider", `Retrying ${provider} (attempt ${attempt + 1})`, { delay });
      await sleep(delay);
    }

    try {
      return provider === "anthropic"
        ? await callAnthropic(prompt, opts)
        : await callOpenAI(prompt, opts);
    } catch (e) {
      lastErr = e;
      if (isNonRetryable(e)) {
        warn("aiProvider", `${provider} non-retryable error — skipping retries`, {
          error: e instanceof Error ? e.message : String(e),
        });
        break;
      }
      warn("aiProvider", `${provider} attempt ${attempt + 1} failed`, {
        error: e instanceof Error ? e.message : String(e),
        willRetry: attempt < MAX_RETRIES,
      });
    }
  }

  throw lastErr ?? new Error(`${provider} failed after ${MAX_RETRIES + 1} attempts`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call the configured LLM with automatic retry + provider fallback.
 * Returns text, the provider that succeeded, and token usage/cost.
 */
export async function callLLM(
  prompt: string,
  opts: CallOptions = {},
): Promise<ProviderResult> {
  const order = resolveOrder();
  if (order.length === 0) {
    throw new Error("No LLM API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  }

  let lastErr: unknown;

  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    const isFallback = i > 0;

    if (isFallback) {
      warn("aiProvider", `Primary provider failed — falling back to ${provider}`);
    }

    try {
      const result = await callWithRetry(provider, prompt, opts);
      log("aiProvider", "LLM call succeeded", {
        provider,
        input_tokens:  result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cost_usd:      result.usage.cost_usd,
        fallback:      isFallback,
      });
      return { ...result, provider };
    } catch (e) {
      lastErr = e;
      logErr("aiProvider", `${provider} exhausted all retries`, {
        error: e instanceof Error ? e.message : String(e),
        hasNextProvider: i < order.length - 1,
      });
    }
  }

  throw lastErr ?? new Error("All LLM providers failed");
}
