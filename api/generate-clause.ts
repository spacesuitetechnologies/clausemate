import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getUserIdFromToken } from "../lib/server/supabase";
import { callLLM } from "../lib/server/aiProvider";
import { checkRateLimit } from "../lib/server/rate-limit";

const FALLBACK_CLAUSE =
  "Party A and Party B agree that this clause shall be governed by mutual consent and applicable Indian law. Both parties shall negotiate in good faith to establish terms that are fair and enforceable. Any disputes arising from this clause shall be resolved through the dispute resolution mechanism set out in this agreement.";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const authHeader = (req.headers?.authorization as string) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  let userId: string;
  try {
    userId = await getUserIdFromToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const { allowed } = await checkRateLimit(userId, "generate-clause");
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const clause = typeof body.clause === "string" ? body.clause.trim().slice(0, 200) : "";
  const fix = typeof body.fix === "string" ? body.fix.trim().slice(0, 500) : "";

  if (!clause || !fix) {
    return res.status(400).json({ error: "clause and fix are required" });
  }

  const prompt = `You are a contract lawyer specialising in Indian law. Write a professional, legally sound clause based on the following:

Clause type: ${clause}
Required fix / intent: ${fix}

Rules:
- Output ONLY the clause text — no title, no explanation, no markdown
- Use clear, formal legal language in accordance with Indian Contract Act, 1872
- Keep it concise (3–6 sentences)
- Use neutral party names like "Party A" and "Party B" as placeholders
- Reference applicable Indian statute if relevant (e.g. Arbitration Act, MSME Act)`;

  try {
    const { text: clauseText, provider } = await callLLM(prompt, {
      maxTokens: 512,
      timeoutMs: 15_000,
    });

    return res.status(200).json({
      clause_text: clauseText || FALLBACK_CLAUSE,
      provider_used: clauseText ? provider : "fallback",
    });
  } catch (err: unknown) {
    console.warn("[generate-clause] All providers failed — returning fallback:", err instanceof Error ? err.message : err);
    return res.status(200).json({ clause_text: FALLBACK_CLAUSE, provider_used: "fallback" });
  }
}
