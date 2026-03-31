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
    console.error("[generate-contract] Missing Supabase env vars");
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
  const type        = typeof body.type        === "string" ? body.type.trim()        : "";
  const partyA      = typeof body.partyA      === "string" ? body.partyA.trim()      : "";
  const partyB      = typeof body.partyB      === "string" ? body.partyB.trim()      : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const extraFields = (typeof body.extra_fields === "object" && body.extra_fields !== null)
    ? body.extra_fields as Record<string, unknown>
    : {};

  if (!type || !partyA || !partyB || !description) {
    return res.status(400).json({ error: "type, partyA, partyB, and description are required" });
  }

  // ── Build extra fields section ────────────────────────────────────────────
  const extraLines = Object.entries(extraFields)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const prompt = `You are an expert Indian contract lawyer. Draft a complete, professionally structured ${type} between the parties below.

Parties:
- Party A: ${partyA}
- Party B: ${partyB}

Contract type: ${type}
Description / purpose: ${description}
${extraLines ? `\nAdditional details:\n${extraLines}` : ""}

Requirements:
- Follow Indian Contract Act, 1872 norms
- Use formal legal language throughout
- Include ALL standard sections for this contract type:
  - Preamble / Background
  - Definitions
  - Scope of Work / Services
  - Payment Terms
  - Term and Termination
  - Confidentiality
  - Intellectual Property (if applicable)
  - Limitation of Liability
  - Indemnification
  - Dispute Resolution (specify arbitration under Indian Arbitration Act)
  - Governing Law (Indian law)
  - General Provisions (amendments, waiver, entire agreement)
  - Signatures block
- Use "${partyA}" and "${partyB}" as party names throughout (not placeholders)
- Number all clauses (1., 1.1, 1.2, etc.)
- Output ONLY the contract text — no preamble, no explanation outside the contract

Draft the full contract now:`;

  // ── Call LLM ──────────────────────────────────────────────────────────────
  try {
    let contractText = "";
    let provider_used: "anthropic" | "openai" | "none" = "none";

    const makeSignal = () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 25_000);
      return controller.signal;
    };

    if (anthropicKey) {
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
            max_tokens: 4096,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: makeSignal(),
        });
        if (r.ok) {
          const data = await r.json() as { content: Array<{ text: string }> };
          contractText = data.content?.[0]?.text?.trim() ?? "";
          if (contractText) provider_used = "anthropic";
        } else {
          console.warn("[generate-contract] Anthropic non-OK:", r.status);
        }
      } catch (e) {
        console.warn("[generate-contract] Anthropic failed:", e instanceof Error ? e.message : e);
      }
    }

    if (!contractText && openaiKey) {
      try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openaiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            max_tokens: 4096,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: makeSignal(),
        });
        if (r.ok) {
          const data = await r.json() as { choices: Array<{ message: { content: string } }> };
          contractText = data.choices?.[0]?.message?.content?.trim() ?? "";
          if (contractText) provider_used = "openai";
        } else {
          console.warn("[generate-contract] OpenAI non-OK:", r.status);
        }
      } catch (e) {
        console.warn("[generate-contract] OpenAI failed:", e instanceof Error ? e.message : e);
      }
    }

    if (!contractText) {
      return res.status(500).json({ error: "Failed to generate contract. Please try again." });
    }

    console.log("[generate-contract] Done. provider:", provider_used, "length:", contractText.length);
    return res.status(200).json({ contract_text: contractText, provider_used });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : "Unknown error";
    console.error("[generate-contract] Fatal:", reason);
    return res.status(500).json({ error: "Failed to generate contract. Please try again." });
  }
}
