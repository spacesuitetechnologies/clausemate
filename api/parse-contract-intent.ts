import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl     = process.env.SUPABASE_URL      ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
const anthropicKey    = process.env.ANTHROPIC_API_KEY ?? "";
const openaiKey       = process.env.OPENAI_API_KEY    ?? "";

function makeSignal(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
}

interface ParsedIntent {
  contract_type: string;
  questions: Array<{ id: string; label: string; placeholder: string; required: boolean }>;
}

function extractJSON(text: string): ParsedIntent | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as ParsedIntent;
    if (
      typeof parsed.contract_type === "string" &&
      Array.isArray(parsed.questions) &&
      parsed.questions.length >= 2
    ) return parsed;
    return null;
  } catch { return null; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("[parse-intent] Missing Supabase env vars");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  const authHeader = (req.headers?.authorization as string) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  try {
    const client = createClient(supabaseUrl, supabaseAnonKey);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Invalid or expired token" });
  } catch {
    return res.status(401).json({ error: "Auth failed" });
  }

  const body = (req.body ?? {}) as { description?: string };
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) return res.status(400).json({ error: "Description is required" });

  const prompt = `You are a contract specialist. A user wants to create a legal contract and described it as:

"${description}"

Identify the most suitable contract type and generate 3–5 targeted follow-up questions to gather the information needed to draft it.

Rules:
- Always include party_a (first party) and party_b (second party) as the first two questions
- Add 1–3 more questions specific to this contract type (payment, duration, location, deliverables, confidentiality scope, etc.)
- Keep question labels concise and practical
- Adapt placeholders to match Indian context (₹ for currency, Indian city names, etc.)

Return ONLY valid JSON, no extra text:
{
  "contract_type": "Service Agreement",
  "questions": [
    { "id": "party_a", "label": "Full name or company of the first party?", "placeholder": "e.g. Acme Solutions Pvt. Ltd.", "required": true },
    { "id": "party_b", "label": "Full name or company of the second party?", "placeholder": "e.g. Rahul Sharma", "required": true },
    { "id": "payment", "label": "Payment amount and schedule?", "placeholder": "e.g. ₹50,000 paid monthly", "required": false }
  ]
}`;

  // Try Anthropic first (faster for classification tasks)
  if (anthropicKey) {
    const { signal, clear } = makeSignal(12_000);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 800,
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });
      clear();
      if (r.ok) {
        const d = await r.json() as { content: Array<{ text: string }> };
        const parsed = extractJSON(d.content?.[0]?.text ?? "");
        if (parsed) {
          console.log("[parse-intent] Anthropic success, type:", parsed.contract_type);
          return res.status(200).json(parsed);
        }
      } else {
        console.warn("[parse-intent] Anthropic non-OK:", r.status);
      }
    } catch (e) {
      clear();
      console.warn("[parse-intent] Anthropic failed:", e instanceof Error ? e.message : e);
    }
  }

  // Fallback: OpenAI
  if (openaiKey) {
    const { signal, clear } = makeSignal(12_000);
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openaiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 800,
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });
      clear();
      if (r.ok) {
        const d = await r.json() as { choices: Array<{ message: { content: string } }> };
        const parsed = extractJSON(d.choices?.[0]?.message?.content ?? "");
        if (parsed) {
          console.log("[parse-intent] OpenAI success, type:", parsed.contract_type);
          return res.status(200).json(parsed);
        }
      } else {
        console.warn("[parse-intent] OpenAI non-OK:", r.status);
      }
    } catch (e) {
      clear();
      console.warn("[parse-intent] OpenAI failed:", e instanceof Error ? e.message : e);
    }
  }

  return res.status(500).json({ error: "Failed to parse contract intent. Please try again." });
}
