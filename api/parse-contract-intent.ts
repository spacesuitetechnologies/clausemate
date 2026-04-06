import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getUserIdFromToken } from "../lib/server/supabase";
import { callLLM } from "../lib/server/aiProvider";

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

  const authHeader = (req.headers?.authorization as string) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  try {
    await getUserIdFromToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const body = (req.body ?? {}) as { description?: string };
  const description = typeof body.description === "string"
    ? body.description.trim().slice(0, 1000)
    : "";
  if (!description) return res.status(400).json({ error: "Description is required" });

  const prompt = `You are a contract specialist. A user wants to create a legal contract and described it as:

"${description}"

Identify the most suitable contract type for Indian law context and generate 3–5 targeted follow-up questions.

Rules:
- Always include party_a (first party) and party_b (second party) as the first two questions
- Add 1–3 more questions specific to this contract type
- Use Indian context in placeholders (₹ for amounts, Indian city names, Indian company suffixes)

Return ONLY valid JSON, no extra text:
{
  "contract_type": "Service Agreement",
  "questions": [
    { "id": "party_a", "label": "Full name or company of the first party?", "placeholder": "e.g. Acme Solutions Pvt. Ltd.", "required": true },
    { "id": "party_b", "label": "Full name or company of the second party?", "placeholder": "e.g. Rahul Sharma", "required": true },
    { "id": "payment", "label": "Payment amount and schedule?", "placeholder": "e.g. ₹50,000 paid monthly on the 1st", "required": false }
  ]
}`;

  try {
    const { text } = await callLLM(prompt, {
      maxTokens: 800,
      timeoutMs: 12_000,
    });
    const parsed = extractJSON(text);
    if (parsed) return res.status(200).json(parsed);
  } catch (err) {
    console.warn("[parse-intent] LLM failed:", err instanceof Error ? err.message : err);
  }

  return res.status(500).json({ error: "Failed to parse contract intent. Please try again." });
}
