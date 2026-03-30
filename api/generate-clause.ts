import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
const openaiKey = process.env.OPENAI_API_KEY ?? "";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ── Env validation ────────────────────────────────────────────────────────
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("[generate-clause] Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = (req.headers?.authorization as string) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  try {
    const anonClient = createClient(supabaseUrl, supabaseAnonKey);
    const { data, error } = await anonClient.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Invalid or expired token" });
  } catch {
    return res.status(401).json({ error: "Auth failed" });
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  const body = (req.body ?? {}) as Record<string, unknown>;
  const clause = typeof body.clause === "string" ? body.clause.trim() : "";
  const fix    = typeof body.fix    === "string" ? body.fix.trim()    : "";

  if (!clause || !fix) {
    return res.status(400).json({ error: "clause and fix are required" });
  }

  const prompt = `You are a contract lawyer. Write a professional, legally sound clause based on the following:

Clause type: ${clause}
Required fix / intent: ${fix}

Rules:
- Output ONLY the clause text itself — no title, no explanation, no markdown
- Use clear, formal legal language
- Keep it concise (3–6 sentences)
- Use neutral party names like "Party A" and "Party B" as placeholders`;

  // ── Call LLM ──────────────────────────────────────────────────────────────
  const FALLBACK_CLAUSE = `Party A and Party B agree that this clause shall be governed by mutual consent and applicable law. Both parties shall negotiate in good faith to establish terms that are fair and enforceable. Any disputes arising from this clause shall be resolved through the dispute resolution mechanism set out in this agreement.`;

  try {
    let clauseText = "";
    let provider_used: "anthropic" | "openai" | "fallback" = "fallback";

    const makeSignal = () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 15_000);
      return controller.signal;
    };

    if (anthropicKey) {
      try {
        const res2 = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 512,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: makeSignal(),
        });
        if (res2.ok) {
          const data = await res2.json() as { content: Array<{ text: string }> };
          clauseText = data.content?.[0]?.text?.trim() ?? "";
          if (clauseText) provider_used = "anthropic";
        } else {
          console.warn("[generate-clause] Anthropic non-OK status:", res2.status, "— will try OpenAI");
        }
      } catch (e) {
        console.warn("[generate-clause] Anthropic failed:", e instanceof Error ? e.message : e, "— will try OpenAI");
      }
    }

    if (!clauseText && openaiKey) {
      try {
        const res2 = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openaiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            max_tokens: 512,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: makeSignal(),
        });
        if (res2.ok) {
          const data = await res2.json() as { choices: Array<{ message: { content: string } }> };
          clauseText = data.choices?.[0]?.message?.content?.trim() ?? "";
          if (clauseText) provider_used = "openai";
        } else {
          console.warn("[generate-clause] OpenAI non-OK status:", res2.status);
        }
      } catch (e) {
        console.warn("[generate-clause] OpenAI failed:", e instanceof Error ? e.message : e);
      }
    }

    if (!clauseText) {
      console.warn("[generate-clause] All providers failed — returning static fallback");
      clauseText = FALLBACK_CLAUSE;
    }

    console.log("[generate-clause] Done. provider_used:", provider_used);
    return res.status(200).json({ clause_text: clauseText, provider_used });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: reason });
  }
}
