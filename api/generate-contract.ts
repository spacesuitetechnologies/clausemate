import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getUserIdFromToken } from "../lib/server/supabase";
import { callLLM } from "../lib/server/aiProvider";
import { checkRateLimit } from "../lib/server/rate-limit";

const MAX_DESCRIPTION_LEN = 2000;

function buildContractPrompt(
  type: string,
  description: string,
  partyA: string,
  partyB: string,
  extraLines: string,
): string {
  return `You are an expert Indian contract lawyer. Draft a complete, professionally structured ${type} between the parties below.

Parties:
- Party A: ${partyA}
- Party B: ${partyB}

Contract type: ${type}
Description / purpose: ${description}
${extraLines ? `\nAdditional details:\n${extraLines}` : ""}

Requirements:
- Follow Indian Contract Act, 1872 norms and applicable Indian statutes
- Use formal legal language throughout
- Include ALL standard sections:
  - Preamble / Background
  - Definitions
  - Scope of Work / Services
  - Payment Terms (reference MSME Act, 2006 where applicable — 45-day payment norm)
  - Term and Termination
  - Confidentiality
  - Intellectual Property (if applicable)
  - Limitation of Liability
  - Indemnification
  - Dispute Resolution (arbitration under Arbitration and Conciliation Act, 1996)
  - Governing Law (Indian law, specify state jurisdiction)
  - General Provisions (amendments, waiver, entire agreement, severability)
  - Signatures block
- Use "${partyA}" and "${partyB}" as party names throughout (not placeholders)
- Number all clauses (1., 1.1, 1.2, etc.)
- Output ONLY the contract text — no preamble, no explanation

Draft the full contract now:`;
}

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

  const { allowed } = await checkRateLimit(userId, "generate-contract");
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests. Please wait before generating another contract." });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const type = typeof body.type === "string" ? body.type.trim().slice(0, 200) : "";
  const description = typeof body.description === "string"
    ? body.description.trim().slice(0, MAX_DESCRIPTION_LEN)
    : "";

  if (!type || !description) {
    return res.status(400).json({ error: "type and description are required" });
  }

  let partyA = "";
  let partyB = "";
  let extraLines = "";

  if (typeof body.answers === "object" && body.answers !== null) {
    const answers = body.answers as Record<string, string>;
    partyA = (answers.party_a ?? "").trim().slice(0, 200);
    partyB = (answers.party_b ?? "").trim().slice(0, 200);
    extraLines = Object.entries(answers)
      .filter(([k]) => k !== "party_a" && k !== "party_b")
      .filter(([, v]) => typeof v === "string" && v.trim())
      .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${String(v).slice(0, 500)}`)
      .join("\n");
  } else {
    partyA = typeof body.partyA === "string" ? body.partyA.trim().slice(0, 200) : "";
    partyB = typeof body.partyB === "string" ? body.partyB.trim().slice(0, 200) : "";
    const extraFields =
      typeof body.extra_fields === "object" && body.extra_fields !== null
        ? (body.extra_fields as Record<string, unknown>)
        : {};
    extraLines = Object.entries(extraFields)
      .filter(([, v]) => v !== "" && v != null)
      .map(([k, v]) => `- ${k}: ${String(v).slice(0, 500)}`)
      .join("\n");
  }

  if (!partyA || !partyB) {
    return res.status(400).json({ error: "Party A and Party B names are required" });
  }

  try {
    const prompt = buildContractPrompt(type, description, partyA, partyB, extraLines);
    const { text: contractText, provider } = await callLLM(prompt, {
      maxTokens: 4096,
      timeoutMs: 25_000,
    });

    if (!contractText) {
      return res.status(500).json({ error: "Failed to generate contract. Please try again." });
    }

    return res.status(200).json({ contract_text: contractText, provider_used: provider });
  } catch (err: unknown) {
    console.error("[generate-contract] Fatal:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Failed to generate contract. Please try again." });
  }
}
