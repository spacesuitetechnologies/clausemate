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
    summary: "Analysis could not be completed." as string,
    risks: [] as string[],
    clauses: [] as string[],
    risk_score: 0 as number,
    error,
    parse_fail_reason: detail ?? error,
  };
}

// ── LLM analysis ──────────────────────────────────────────────────────────────

interface StructuredRisk {
  level: "low" | "medium" | "high";
  reason: string;
}

interface StructuredClauses {
  termination: string | null;
  payment: string | null;
  liability: string | null;
  [key: string]: string | null;
}

interface LLMResult {
  summary: string;
  risk_score: number;
  risks: string[];           // derived: "[high] reason" — kept for frontend compat
  clauses: string[];         // derived: clause keys present — kept for frontend compat
  parties: string[];
  effective_date: string | null;
  jurisdiction: string | null;
  structured_risks: StructuredRisk[];
  structured_clauses: StructuredClauses;
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
  return `You are an expert Indian contract lawyer. Analyze this contract and respond with ONLY a valid JSON object — no markdown, no explanation, no extra text outside the JSON.

Required JSON format:
{
  "parties": ["Party 1 name", "Party 2 name"],
  "effective_date": "YYYY-MM-DD or descriptive date string, or null if not found",
  "jurisdiction": "Governing law / jurisdiction string, or null if not found",
  "clauses": {
    "termination": "Summary of termination clause, or null",
    "payment": "Summary of payment terms, or null",
    "liability": "Summary of liability clause, or null"
  },
  "risks": [
    { "level": "high", "reason": "One-line description of the risk" },
    { "level": "medium", "reason": "One-line description of the risk" },
    { "level": "low", "reason": "One-line description of the risk" }
  ],
  "summary": "2-3 sentence executive summary of what this contract is and its key concerns"
}

Rules:
- Extract exact data from the contract; do not invent or assume
- If a field is not found in the contract, return null for that field
- risks: list 2-6 genuine risks; level must be exactly "low", "medium", or "high"
- Be concise and practical; apply Indian law perspective

CONTRACT:
${contractText}`;
}

const RISK_LEVEL_SCORE: Record<string, number> = { high: 80, medium: 50, low: 20 };

function parseLLMResponse(raw: string): LLMResult {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("LLM returned invalid JSON");
  }

  // ── Structured risks ──────────────────────────────────────────────────────
  const structuredRisks: StructuredRisk[] = Array.isArray(parsed.risks)
    ? (parsed.risks as unknown[]).flatMap((r) => {
        if (typeof r === "object" && r !== null && "reason" in r) {
          const level = String((r as Record<string, unknown>).level ?? "medium").toLowerCase();
          const validLevel = (["low", "medium", "high"].includes(level) ? level : "medium") as StructuredRisk["level"];
          return [{ level: validLevel, reason: String((r as Record<string, unknown>).reason ?? "") }];
        }
        // Tolerate legacy plain-string format from model
        if (typeof r === "string") return [{ level: "medium" as const, reason: r }];
        return [];
      }).filter((r) => r.reason)
    : [];

  // ── Structured clauses ────────────────────────────────────────────────────
  const rawClauses = (typeof parsed.clauses === "object" && parsed.clauses !== null && !Array.isArray(parsed.clauses))
    ? parsed.clauses as Record<string, unknown>
    : {};

  const structuredClauses: StructuredClauses = {
    termination: rawClauses.termination != null ? String(rawClauses.termination) : null,
    payment:     rawClauses.payment     != null ? String(rawClauses.payment)     : null,
    liability:   rawClauses.liability   != null ? String(rawClauses.liability)   : null,
  };

  // ── Derived flat arrays for frontend compat ───────────────────────────────
  const risks: string[] = structuredRisks.map((r) => `[${r.level}] ${r.reason}`);

  const clauses: string[] = Object.entries(structuredClauses)
    .filter(([, v]) => v !== null)
    .map(([k]) => k.charAt(0).toUpperCase() + k.slice(1));

  // ── Risk score: average of individual levels, default 50 ─────────────────
  const risk_score = structuredRisks.length > 0
    ? Math.round(structuredRisks.reduce((sum, r) => sum + (RISK_LEVEL_SCORE[r.level] ?? 50), 0) / structuredRisks.length)
    : 50;

  // ── Metadata ──────────────────────────────────────────────────────────────
  const parties = Array.isArray(parsed.parties)
    ? (parsed.parties as unknown[]).map(String).filter(Boolean)
    : [];

  const effective_date = parsed.effective_date != null ? String(parsed.effective_date) : null;
  const jurisdiction   = parsed.jurisdiction   != null ? String(parsed.jurisdiction)   : null;

  return {
    summary: String(parsed.summary ?? "Contract analysis complete."),
    risk_score,
    risks,
    clauses,
    parties,
    effective_date,
    jurisdiction,
    structured_risks: structuredRisks,
    structured_clauses: structuredClauses,
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

// ── AI OCR — send document to OpenAI for text extraction ─────────────────────
// PDFs sent as input_file; images sent as input_image.
// No pdfjs, no canvas, no worker — runs cleanly on Vercel.

async function aiOCR(buffer: Buffer, mimeType: "application/pdf" | "image/jpeg" | "image/png" = "application/pdf"): Promise<string> {
  if (!openaiKey) throw new Error("OPENAI_API_KEY not set — AI OCR unavailable");

  console.log("[AI OCR] sending request — buffer length:", buffer.length, "mime:", mimeType);

  const base64 = buffer.toString("base64");

  const content =
    mimeType === "application/pdf"
      ? [
          { type: "input_text", text: "Extract all readable text from this PDF document." },
          { type: "input_file", file_data: `data:application/pdf;base64,${base64}` },
        ]
      : [
          { type: "input_text", text: "Extract all readable text from this image." },
          { type: "input_image", image_url: `data:${mimeType};base64,${base64}` },
        ];

  if (!Array.isArray(content) || content.length !== 2) {
    throw new Error("INVALID OCR CONTENT STRUCTURE");
  }

  const requestBody = {
    model: "gpt-4o-mini",
    input: [{ role: "user", content }],
  };

  console.log("[AI OCR REAL REQUEST]", JSON.stringify(requestBody, null, 2));

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  console.log("[AI OCR] status:", response.status);

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`AI OCR API error ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = await response.json();
  console.log("[AI OCR RAW RESPONSE]", JSON.stringify(data, null, 2));

  const ocrText: string =
    data.output_text ||
    (Array.isArray(data.output)
      ? data.output.map((o: { content?: Array<{ text?: string }> }) =>
          Array.isArray(o.content) ? o.content.map((c) => c.text || "").join("") : ""
        ).join("")
      : "") ||
    "";

  console.log("[AI OCR TEXT LENGTH]", ocrText.length);

  return ocrText.trim();
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // ── Method guard ──────────────────────────────────────────────────────────
    if (req.method !== "POST") {
      return res.status(405).json(safeExit("Method Not Allowed"));
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
      return res.status(401).json(safeExit("Missing authorization token"));
    }

    let userId: string;
    try {
      const anonClient = createClient(supabaseUrl, supabaseAnonKey);
      const { data, error: authError } = await anonClient.auth.getUser(token);
      if (authError || !data?.user) {
        return res.status(401).json(safeExit("Invalid or expired token"));
      }
      userId = data.user.id;
    } catch (authEx: unknown) {
      const msg = authEx instanceof Error ? authEx.message : "Auth exception";
      console.error("[analyze] Auth exception:", msg);
      return res.status(401).json(safeExit("Auth failed"));
    }

    // ── Rate limiting ─────────────────────────────────────────────────────────
    const now = Date.now();
    const last = lastRequestAt.get(userId) ?? 0;
    if (now - last < RATE_LIMIT_MS) {
      return res.status(429).json(safeExit("Too many requests. Please wait before analyzing again."));
    }
    lastRequestAt.set(userId, now);

    // ── Input validation ──────────────────────────────────────────────────────
    const body = (req.body ?? {}) as Record<string, unknown>;
    console.log("[analyze] REQUEST:", JSON.stringify({ contract_id: body.contract_id, include_redlines: body.include_redlines }));

    const contract_id = body.contract_id;
    const include_redlines = body.include_redlines === true;

    if (!contract_id || typeof contract_id !== "string") {
      return res.status(400).json(safeExit("contract_id is required and must be a string"));
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
        return res.status(404).json(safeExit("Contract not found"));
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

    console.log("[analyze] FILE SIZE:", fileBlob?.size ?? 0);

    if (!fileBlob || fileBlob.size === 0) {
      return res.status(200).json(safeExit("PARSE_FAILED", "File is empty"));
    }

    // ── Detect file type from filename / storage path ────────────────────────
    const filePath: string = contract.file_url ?? "";
    const filename: string = contract.filename ?? "";
    const ext = (filename.split(".").pop() ?? filePath.split(".").pop() ?? "").toLowerCase();
    const isPdf  = ext === "pdf"  || filePath.toLowerCase().includes(".pdf");
    const isDocx = ext === "docx" || filePath.toLowerCase().includes(".docx");
    const isTxt  = ext === "txt"  || filePath.toLowerCase().includes(".txt");
    const isImage = ["jpg", "jpeg", "png", "webp", "bmp", "tiff"].includes(ext);

    console.log("[TYPE]:", ext || "unknown");

    // ── Buffer ────────────────────────────────────────────────────────────────
    const arrayBuffer = await fileBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log("[STEP] buffer size:", buffer.length, "file type:", ext || "unknown");

    // ── Extract text from file ────────────────────────────────────────────────
    let extractedText = "";

    if (isPdf) {
      // ── Primary parser: pdf-parse ───────────────────────────────────────────
      try {
        const pdfModule = await import("pdf-parse");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdfParse = (pdfModule as any).default ?? pdfModule;
        const parsed = await pdfParse(buffer);
        extractedText = parsed?.text?.trim() ?? "";
        console.log("[DEBUG] PDF PARSE RESULT LENGTH:", extractedText?.length);
        console.log("[DEBUG] PDF PARSE RAW:", extractedText?.slice(0, 200));
      } catch (primaryErr: unknown) {
        console.warn("[PARSE FAILED] continuing with AI OCR:", primaryErr instanceof Error ? primaryErr.message : primaryErr);
      }

      // ── AI OCR fallback (scanned / image-only PDFs) ─────────────────────────
      if (!extractedText || extractedText.length < 50) {
        console.log("[FORCE OCR] No text from PDF, using AI OCR");
        try {
          const ocrText = await aiOCR(buffer, "application/pdf");
          console.log("[OCR] length:", ocrText.length);
          if (ocrText && ocrText.length > 20) {
            extractedText = ocrText;
          } else {
            console.warn("[OCR] AI returned empty, continuing anyway");
          }
        } catch (ocrErr: unknown) {
          console.warn("[OCR] AI OCR failed:", ocrErr instanceof Error ? ocrErr.message : ocrErr);
        }
      }

    } else if (isDocx) {
      // ── DOCX: mammoth ────────────────────────────────────────────────────────
      try {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value?.trim() ?? "";
        console.log("[analyze] mammoth result length:", extractedText.length);
      } catch (docxErr: unknown) {
        console.warn("[analyze] mammoth failed:", docxErr instanceof Error ? docxErr.message : docxErr);
      }

    } else if (isTxt) {
      // ── Plain text ───────────────────────────────────────────────────────────
      extractedText = buffer.toString("utf-8").trim();
      console.log("[analyze] txt result length:", extractedText.length);

    } else if (isImage) {
      // ── Image: AI OCR directly ───────────────────────────────────────────────
      console.log("[OCR] triggered for image");
      const imgMime = ext === "png" ? "image/png" : "image/jpeg";
      try {
        extractedText = await aiOCR(buffer, imgMime as "image/png" | "image/jpeg");
        console.log("[OCR] length:", extractedText.length);
      } catch (imgOcrErr: unknown) {
        console.warn("[OCR] image AI OCR failed:", imgOcrErr instanceof Error ? imgOcrErr.message : imgOcrErr);
      }

    } else {
      // ── Unknown: best-effort UTF-8 decode ────────────────────────────────────
      console.warn("[analyze] Unknown file type, attempting UTF-8 decode");
      extractedText = buffer.toString("utf-8").trim();
    }

    // ── Always proceed to AI analysis — no early returns after this point ─────
    console.log("[TEXT LENGTH]:", extractedText.length);

    if (!extractedText || extractedText.trim().length === 0) {
      console.error("[analyze] No text after all parsers and OCR — returning PARSE_FAILED");
      return res.status(200).json(safeExit("PARSE_FAILED", "No text could be extracted from the document. It may be a scanned image that could not be read by OCR."));
    }

    const trimmedText = extractedText.length > MAX_TEXT_CHARS
      ? extractedText.slice(0, MAX_TEXT_CHARS)
      : extractedText;

    console.log("[analyze] proceeding to AI with text length:", trimmedText.length);

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
      // ── Frontend-compat fields (flat) ──────────────────────────────────────
      summary: result.summary,
      risks: result.risks,
      clauses: result.clauses,
      risk_score: result.risk_score,
      // ── Structured extraction fields ───────────────────────────────────────
      parties: result.parties,
      effective_date: result.effective_date,
      jurisdiction: result.jurisdiction,
      structured_risks: result.structured_risks,
      structured_clauses: result.structured_clauses,
      // ── Metadata ──────────────────────────────────────────────────────────
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
