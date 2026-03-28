import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// ── Env vars ──────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
const openaiKey = process.env.OPENAI_API_KEY ?? "";

// Max characters passed to LLM — controls token cost
const MAX_TEXT_CHARS = 40_000;

// ── In-memory rate limit (resets on cold-start — acceptable for serverless) ──
const lastRequestAt = new Map<string, number>();
const RATE_LIMIT_MS = 5_000;

// ── Safe fallback — always valid AnalyzeContractResult shape ─────────────────
function safeExit(error: string, detail?: string) {
  return {
    summary: null as string | null,
    risks: [] as string[],
    clauses: [] as string[],
    risk_score: null as number | null,
    error,
    parse_fail_reason: detail ?? error,
  };
}

// ── LLM analysis ──────────────────────────────────────────────────────────────

interface LLMResult {
  summary: string;
  risk_score: number;
  risks: string[];
  clauses: string[];
}

async function callAnthropic(text: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: buildPrompt(text) }],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content?.[0]?.text ?? "";
}

async function callOpenAI(text: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: buildPrompt(text) }],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI API error ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

function buildPrompt(contractText: string): string {
  return `You are an expert Indian contract lawyer. Analyze this contract and respond with ONLY a valid JSON object — no markdown, no explanation, just the JSON.

JSON format:
{
  "summary": "2-3 sentence executive summary of what this contract is and key concerns",
  "risk_score": <integer 0-100, higher means more risk>,
  "risks": [
    "Brief description of a significant risk or concern in this contract",
    ...
  ],
  "clauses": [
    "Clause name (e.g. Payment Terms)",
    ...
  ]
}

Rules:
- Extract 5-12 most important clauses by name only (just the title, no details)
- List 2-6 genuine risks as short one-line descriptions
- risk_score should reflect overall legal risk under Indian law
- Be concise and practical

CONTRACT:
${contractText}`;
}

function parseLLMResponse(raw: string): LLMResult {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("LLM returned invalid JSON");
  }

  const risks = Array.isArray(parsed.risks)
    ? (parsed.risks as unknown[]).map(String).filter(Boolean)
    : [];

  const clauses = Array.isArray(parsed.clauses)
    ? (parsed.clauses as unknown[]).map(String).filter(Boolean)
    : [];

  const risk_score = Math.min(100, Math.max(0, Math.round(Number(parsed.risk_score ?? 50))));

  return {
    summary: String(parsed.summary ?? "Contract analysis complete."),
    risk_score,
    risks,
    clauses,
  };
}

async function analyzeWithLLM(contractText: string): Promise<LLMResult> {
  if (anthropicKey) {
    try {
      const raw = await callAnthropic(contractText);
      return parseLLMResponse(raw);
    } catch (err) {
      console.error("[analyze] Anthropic failed, trying OpenAI:", err instanceof Error ? err.message : err);
    }
  }

  if (openaiKey) {
    const raw = await callOpenAI(contractText);
    return parseLLMResponse(raw);
  }

  throw new Error("No LLM API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in environment variables.");
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // ── Method guard ──────────────────────────────────────────────────────────
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed", ...safeExit("METHOD_ERROR") });
    }

    // ── Config check ──────────────────────────────────────────────────────────
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      console.error("[analyze] Missing Supabase env vars");
      return res.status(200).json(safeExit("CONFIG_ERROR", "Server misconfigured — missing Supabase environment variables"));
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = (req.headers?.authorization as string) ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing authorization token", ...safeExit("AUTH_ERROR") });
    }

    let userId: string;
    try {
      const anonClient = createClient(supabaseUrl, supabaseAnonKey);
      const { data, error: authError } = await anonClient.auth.getUser(token);
      if (authError || !data?.user) {
        return res.status(401).json({ error: "Invalid or expired token", ...safeExit("AUTH_ERROR") });
      }
      userId = data.user.id;
    } catch (authEx: unknown) {
      const msg = authEx instanceof Error ? authEx.message : "Auth exception";
      console.error("[analyze] Auth exception:", msg);
      return res.status(401).json({ error: "Auth failed", ...safeExit("AUTH_ERROR") });
    }

    // ── Rate limiting ─────────────────────────────────────────────────────────
    const now = Date.now();
    const last = lastRequestAt.get(userId) ?? 0;
    if (now - last < RATE_LIMIT_MS) {
      return res.status(429).json({
        error: "Too many requests. Please wait before analyzing again.",
        ...safeExit("RATE_LIMIT"),
      });
    }
    lastRequestAt.set(userId, now);

    // ── Input validation ──────────────────────────────────────────────────────
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contract_id = body.contract_id;
    const include_redlines = body.include_redlines === true;

    if (!contract_id || typeof contract_id !== "string") {
      return res.status(400).json({ error: "contract_id is required and must be a string", ...safeExit("VALIDATION_ERROR") });
    }

    // ── Fetch contract (ownership enforced via user_id) ───────────────────────
    let contract: { file_url: string; filename: string } | null = null;
    try {
      const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
      const { data, error: contractError } = await serviceClient
        .from("contracts")
        .select("file_url, filename")
        .eq("id", contract_id)
        .eq("user_id", userId)
        .single();

      if (contractError || !data) {
        console.error("[analyze] Contract lookup failed:", contractError?.message);
        return res.status(404).json({ error: "Contract not found", ...safeExit("NOT_FOUND") });
      }
      contract = data as { file_url: string; filename: string };
    } catch (dbEx: unknown) {
      const msg = dbEx instanceof Error ? dbEx.message : "DB exception";
      console.error("[analyze] Contract fetch exception:", msg);
      return res.status(200).json(safeExit("DB_ERROR", msg));
    }

    // ── Download file from Supabase Storage ───────────────────────────────────
    let fileBlob: Blob | null = null;
    try {
      const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
      const { data, error: downloadError } = await serviceClient.storage
        .from("contracts")
        .download(contract.file_url);

      if (downloadError || !data) {
        console.error("[analyze] Download failed:", downloadError?.message);
        return res.status(200).json(safeExit("DOWNLOAD_ERROR", downloadError?.message ?? "Could not retrieve file from storage"));
      }
      fileBlob = data;
    } catch (dlEx: unknown) {
      const msg = dlEx instanceof Error ? dlEx.message : "Download exception";
      console.error("[analyze] Download exception:", msg);
      return res.status(200).json(safeExit("DOWNLOAD_ERROR", msg));
    }

    if (!fileBlob || fileBlob.size === 0) {
      return res.status(200).json(safeExit("PARSE_FAILED", "File is empty"));
    }

    // ── Extract text from file ────────────────────────────────────────────────
    let extractedText = "";
    try {
      const arrayBuffer = await fileBlob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const filePath: string = contract.file_url ?? "";
      const filename: string = contract.filename ?? "";
      const isPdf =
        filePath.toLowerCase().includes(".pdf") ||
        filename.toLowerCase().endsWith(".pdf");

      if (isPdf) {
        // pdf-parse v2: named export PDFParse class
        // new PDFParse({ data: buffer }) → parser.getText() → TextResult { text: string }
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: buffer });
        try {
          const result = await parser.getText();
          extractedText = result.text?.trim() ?? "";
        } finally {
          await parser.destroy();
        }
      } else {
        // Plain text fallback
        extractedText = buffer.toString("utf-8").trim();
      }
    } catch (parseEx: unknown) {
      const reason = parseEx instanceof Error ? parseEx.message : "Unknown parse error";
      console.error("[analyze] Text extraction failed:", reason);
      return res.status(200).json(safeExit("PARSE_FAILED", reason));
    }

    if (!extractedText) {
      return res.status(200).json(safeExit("PARSE_FAILED", "No text could be extracted — document may be a scanned image"));
    }

    const trimmedText =
      extractedText.length > MAX_TEXT_CHARS
        ? extractedText.slice(0, MAX_TEXT_CHARS)
        : extractedText;

    console.log("[analyze] Text extracted, length:", trimmedText.length, "include_redlines:", include_redlines);

    // ── LLM Analysis ─────────────────────────────────────────────────────────
    let result: LLMResult;
    try {
      result = await analyzeWithLLM(trimmedText);
    } catch (llmEx: unknown) {
      const reason = llmEx instanceof Error ? llmEx.message : "LLM error";
      console.error("[analyze] LLM failed:", reason);
      return res.status(200).json(safeExit("LLM_ERROR", reason));
    }

    console.log("[analyze] Done. risk_score:", result.risk_score, "clauses:", result.clauses.length);

    return res.status(200).json({
      summary: result.summary,
      risks: result.risks,
      clauses: result.clauses,
      risk_score: result.risk_score,
      contract_id,
      filename: contract.filename ?? "",
      was_trimmed: extractedText.length > MAX_TEXT_CHARS,
      include_redlines,
    });

  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : "UNKNOWN_ERROR";
    console.error("[analyze] FATAL:", err);
    return res.status(200).json(safeExit("INTERNAL_ERROR", reason));
  }
}
