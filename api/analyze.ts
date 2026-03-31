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
    missing_clauses: [] as MissingClause[],
    suggestions: [] as Suggestion[],
    error,
    parse_fail_reason: detail ?? error,
  };
}

// ── LLM analysis ──────────────────────────────────────────────────────────────

interface StructuredRisk {
  level: "low" | "medium" | "high";
  reason: string;
  clause?: string;
  issue?: string;
  impact?: string;
}

interface StructuredClauses {
  termination: string | null;
  payment: string | null;
  liability: string | null;
  [key: string]: string | null;
}

interface MissingClause {
  clause: string;
  importance: string;
  risk: string;
}

interface Suggestion {
  clause: string;
  fix: string;
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
  missing_clauses: MissingClause[];
  suggestions: Suggestion[];
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
  return `You are an expert contract risk analyst.

Analyze the contract and return ONLY valid JSON — no markdown, no explanation, no text outside the JSON.

Required JSON format:
{
  "parties": ["Party 1 name", "Party 2 name"],
  "effective_date": "YYYY-MM-DD or descriptive date string, or null if not found",
  "jurisdiction": "Governing law / jurisdiction string, or null if not found",
  "summary": "2-3 lines in simple English: what this contract is, who it binds, and its biggest concern",
  "risks": [
    {
      "level": "high",
      "clause": "Name of the clause (e.g. Indemnification)",
      "issue": "What is wrong or one-sided",
      "impact": "Real-world consequence (e.g. You may owe unlimited damages)",
      "reason": "Why this is a risk"
    }
  ],
  "missing_clauses": [
    {
      "clause": "Clause name (e.g. Limitation of Liability)",
      "importance": "Why this clause is standard",
      "risk": "What could go wrong without it"
    }
  ],
  "suggestions": [
    {
      "clause": "Clause name",
      "fix": "Specific change to negotiate or add"
    }
  ],
  "clauses": ["Termination", "Payment", "Liability"],
  "risk_score": 65
}

Rules:
- Be specific, not generic — reference actual clause language where possible
- Mention money or legal consequences clearly in impact fields
- risks: list 2-6 genuine risks; level must be exactly "low", "medium", or "high"
- missing_clauses: list 1-4 clauses absent from the contract that a party should insist on
- suggestions: list 1-4 concrete negotiation fixes
- clauses: list all major clause types present in the contract
- risk_score: 0-100 integer (0=no risk, 100=extremely dangerous)
- Keep all values concise

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
        if (typeof r === "object" && r !== null) {
          const obj = r as Record<string, unknown>;
          const level = String(obj.level ?? "medium").toLowerCase();
          const validLevel = (["low", "medium", "high"].includes(level) ? level : "medium") as StructuredRisk["level"];
          const reason = String(obj.reason ?? obj.issue ?? "");
          if (!reason) return [];
          return [{
            level: validLevel,
            reason,
            ...(obj.clause  != null ? { clause: String(obj.clause) }  : {}),
            ...(obj.issue   != null ? { issue:  String(obj.issue)  }  : {}),
            ...(obj.impact  != null ? { impact: String(obj.impact) }  : {}),
          }];
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

  // When clauses is a flat string array (new prompt format), derive structured keys from it
  const clauseNames: string[] = Array.isArray(parsed.clauses)
    ? (parsed.clauses as unknown[]).map(String).filter(Boolean)
    : [];

  const structuredClauses: StructuredClauses = {
    termination: rawClauses.termination != null ? String(rawClauses.termination) : (clauseNames.find((c) => /terminat/i.test(c)) ?? null),
    payment:     rawClauses.payment     != null ? String(rawClauses.payment)     : (clauseNames.find((c) => /payment|invoice|fee/i.test(c)) ?? null),
    liability:   rawClauses.liability   != null ? String(rawClauses.liability)   : (clauseNames.find((c) => /liabilit/i.test(c)) ?? null),
  };

  // ── Derived flat arrays for frontend compat ───────────────────────────────
  const risks: string[] = structuredRisks.map((r) => `[${r.level}] ${r.reason}`);

  // clauses: prefer flat string array from model, fall back to structured keys
  const clauses: string[] = Array.isArray(parsed.clauses)
    ? (parsed.clauses as unknown[]).map(String).filter(Boolean)
    : Object.entries(structuredClauses)
        .filter(([, v]) => v !== null)
        .map(([k]) => k.charAt(0).toUpperCase() + k.slice(1));

  // ── Risk score: use model-provided value if valid, else compute from risks ─
  const modelScore = typeof parsed.risk_score === "number" ? parsed.risk_score : null;
  const risk_score = (modelScore !== null && modelScore >= 0 && modelScore <= 100)
    ? Math.round(modelScore)
    : structuredRisks.length > 0
      ? Math.round(structuredRisks.reduce((sum, r) => sum + (RISK_LEVEL_SCORE[r.level] ?? 50), 0) / structuredRisks.length)
      : 50;

  // ── missing_clauses ───────────────────────────────────────────────────────
  const missing_clauses: MissingClause[] = Array.isArray(parsed.missing_clauses)
    ? (parsed.missing_clauses as unknown[]).flatMap((m) => {
        if (typeof m === "object" && m !== null) {
          const obj = m as Record<string, unknown>;
          const clause = String(obj.clause ?? "").trim();
          if (!clause) return [];
          return [{ clause, importance: String(obj.importance ?? ""), risk: String(obj.risk ?? "") }];
        }
        return [];
      })
    : [];

  // ── suggestions ───────────────────────────────────────────────────────────
  const suggestions: Suggestion[] = Array.isArray(parsed.suggestions)
    ? (parsed.suggestions as unknown[]).flatMap((s) => {
        if (typeof s === "object" && s !== null) {
          const obj = s as Record<string, unknown>;
          const clause = String(obj.clause ?? "").trim();
          if (!clause) return [];
          return [{ clause, fix: String(obj.fix ?? "") }];
        }
        return [];
      })
    : [];

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
    missing_clauses,
    suggestions,
  };
}

// ── Policy evaluation ─────────────────────────────────────────────────────────

interface Policy {
  name: string;
  category: string;
  risk_level: "low" | "medium" | "high";
  explanation: string;
  check: (result: LLMResult) => boolean;
}

// Built-in policies — evaluated against the LLM result
const BUILT_IN_POLICIES: Policy[] = [
  {
    name: "Missing Indemnification Clause",
    category: "indemnification",
    risk_level: "high",
    explanation: "No indemnification clause found. Either party may be exposed to unlimited third-party claims without contractual protection.",
    check: (r) => !r.clauses.some((c) => /indemni/i.test(c)) &&
                   !r.structured_clauses.liability &&
                   !r.missing_clauses.some((m) => /indemni/i.test(m.clause)),
  },
  {
    name: "Missing Limitation of Liability",
    category: "liability",
    risk_level: "high",
    explanation: "No limitation of liability clause detected. Damages could be uncapped — a significant financial exposure.",
    check: (r) => !r.clauses.some((c) => /liabilit/i.test(c)) &&
                   !r.structured_clauses.liability,
  },
  {
    name: "Missing Termination Clause",
    category: "termination",
    risk_level: "medium",
    explanation: "No termination clause found. Either party may be locked into the contract with no clear exit mechanism.",
    check: (r) => !r.clauses.some((c) => /terminat/i.test(c)) &&
                   !r.structured_clauses.termination,
  },
  {
    name: "Missing Dispute Resolution",
    category: "dispute",
    risk_level: "medium",
    explanation: "No dispute resolution or arbitration clause found. Disputes will default to litigation, which is costly and slow.",
    check: (r) => !r.clauses.some((c) => /dispute|arbitrat|mediat/i.test(c)),
  },
  {
    name: "Missing Governing Law / Jurisdiction",
    category: "jurisdiction",
    risk_level: "medium",
    explanation: "No governing law or jurisdiction specified. In cross-border contracts this creates ambiguity about which courts and laws apply.",
    check: (r) => !r.jurisdiction && !r.clauses.some((c) => /jurisdiction|governing law/i.test(c)),
  },
  {
    name: "Missing Confidentiality Clause",
    category: "confidentiality",
    risk_level: "medium",
    explanation: "No confidentiality or NDA clause found. Sensitive business information shared under this contract may not be protected.",
    check: (r) => !r.clauses.some((c) => /confidential|nda|non-disclosure/i.test(c)),
  },
  {
    name: "Missing Payment Terms",
    category: "payment",
    risk_level: "medium",
    explanation: "No payment terms clause found. Without defined payment schedules and penalties, late or non-payment may go unaddressed.",
    check: (r) => !r.clauses.some((c) => /payment|invoice|fee/i.test(c)) &&
                   !r.structured_clauses.payment,
  },
  {
    name: "Missing Intellectual Property Ownership",
    category: "ip",
    risk_level: "medium",
    explanation: "No IP ownership clause detected. Work product or inventions created under this contract may have unclear ownership.",
    check: (r) => !r.clauses.some((c) => /intellectual property|ip ownership|copyright|work for hire/i.test(c)),
  },
  {
    name: "Missing Force Majeure",
    category: "force_majeure",
    risk_level: "low",
    explanation: "No force majeure clause found. Parties may have no protection against liability for events outside their control.",
    check: (r) => !r.clauses.some((c) => /force majeure|act of god|unforeseeable/i.test(c)),
  },
];

function evaluatePolicies(result: LLMResult): StructuredRisk[] {
  const triggered = BUILT_IN_POLICIES.filter((p) => p.check(result));

  // Deduplicate against existing AI risks — skip if AI already flagged same category
  const existingReasons = new Set(
    result.structured_risks.map((r) => (r.clause ?? r.reason).toLowerCase())
  );

  return triggered
    .filter((p) => {
      const key = p.category.toLowerCase();
      return !Array.from(existingReasons).some((r) => r.includes(key));
    })
    .map((p) => ({
      level: p.risk_level,
      reason: p.explanation,
      clause: p.name,
    }));
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

// ── AI OCR — upload file to OpenAI then extract text via Responses API ────────

async function aiOCR(buffer: Buffer, mimeType: "application/pdf" | "image/jpeg" | "image/png" = "application/pdf"): Promise<string> {
  if (!openaiKey) throw new Error("OPENAI_API_KEY not set — AI OCR unavailable");

  // STEP 1: Upload file to OpenAI
  console.log("[AI OCR] uploading file, size:", buffer.length, "mime:", mimeType);
  const ext = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
  const filename = `document.${ext}`;

  const formData = new FormData();
  formData.append("purpose", "assistants");
  formData.append("file", new Blob([buffer], { type: mimeType }), filename);

  const uploadRes = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => "");
    throw new Error(`OpenAI file upload failed ${uploadRes.status}: ${err.slice(0, 300)}`);
  }

  const uploadData = await uploadRes.json() as { id: string };
  const uploadedFileId = uploadData.id;
  console.log("[AI OCR] file uploaded, id:", uploadedFileId);

  // STEP 2: Send file_id to Responses API
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Extract all readable text from this contract." },
            { type: "input_file", file_id: uploadedFileId },
          ],
        },
      ],
    }),
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

    // ── Policy evaluation — merge with AI risks ───────────────────────────────
    const policyRisks = evaluatePolicies(result);
    if (policyRisks.length > 0) {
      console.log("[analyze] policy risks triggered:", policyRisks.length);
      result.structured_risks = [...result.structured_risks, ...policyRisks];
      result.risks = result.structured_risks.map((r) => `[${r.level}] ${r.reason}`);
      // Recompute risk_score including policy risks
      const RISK_SCORE: Record<string, number> = { high: 80, medium: 50, low: 20 };
      result.risk_score = Math.round(
        result.structured_risks.reduce((sum, r) => sum + (RISK_SCORE[r.level] ?? 50), 0) /
        result.structured_risks.length
      );
    }

    console.log("[analyze] Done. risk_score:", result.risk_score, "clauses:", result.clauses.length, "policy_risks:", policyRisks.length);

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
      missing_clauses: result.missing_clauses,
      suggestions: result.suggestions,
      // ── Metadata ──────────────────────────────────────────────────────────
      contract_id,
      filename: contract.filename ?? "",
      was_trimmed: extractedText.length > MAX_TEXT_CHARS,
      include_redlines,
      contract_text: trimmedText,
    });

  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : "UNKNOWN_ERROR";
    console.error("[analyze] FATAL:", err);
    return res.status(200).json(safeExit("INTERNAL_ERROR", reason));
  }
}
