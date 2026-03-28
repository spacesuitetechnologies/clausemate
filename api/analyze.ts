import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { PDFParse } from "pdf-parse";

// ── Env vars ─────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// Max characters to pass to LLM — controls token cost
const MAX_TEXT_CHARS = 40_000;

// ── In-memory rate limit (resets on cold-start — acceptable for serverless) ──
const lastRequestAt = new Map<string, number>();
const RATE_LIMIT_MS = 5_000;

// ── Graceful parse-failed response shape ──────────────────────────────────────
function parseFailed(reason: string) {
  return {
    summary: "Could not extract text from PDF. File may be scanned or invalid.",
    risks: [] as string[],
    clauses: [] as string[],
    risk_score: null,
    error: "PARSE_FAILED",
    parse_fail_reason: reason,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // ── Method guard ──────────────────────────────────────────────────────────
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // ── Config check ──────────────────────────────────────────────────────────
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      console.error("[analyze] Missing required env vars (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY)");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // ── Auth validation ───────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing authorization token" });
    }

    const anonClient = createClient(supabaseUrl, supabaseAnonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // ── Rate limiting ─────────────────────────────────────────────────────────
    const now = Date.now();
    const last = lastRequestAt.get(user.id) ?? 0;
    if (now - last < RATE_LIMIT_MS) {
      return res.status(429).json({ error: "Too many requests. Please wait before analyzing again." });
    }
    lastRequestAt.set(user.id, now);

    // ── Input validation ──────────────────────────────────────────────────────
    console.log("REQ BODY:", req.body);

    const body = req.body || {};
    const contract_id: unknown = body.contract_id;
    const include_redlines: boolean = body.include_redlines === true;

    console.log("Analyze request:", { contract_id, include_redlines });

    if (!contract_id || typeof contract_id !== "string") {
      return res.status(400).json({ error: "Invalid contract_id" });
    }

    // ── Fetch contract (ownership enforced via user_id) ───────────────────────
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    const { data: contract, error: contractError } = await serviceClient
      .from("contracts")
      .select("file_url, filename")
      .eq("id", contract_id)
      .eq("user_id", user.id)
      .single();

    console.log("[analyze] Contract lookup:", { found: !!contract, error: contractError?.message });

    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }

    // ── File type guard ───────────────────────────────────────────────────────
    const filePath: string = contract.file_url ?? "";
    if (!filePath.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ error: "Invalid file type. Only PDF allowed." });
    }

    // ── Download file from Supabase Storage ───────────────────────────────────
    const { data: fileBlob, error: downloadError } = await serviceClient.storage
      .from("contracts")
      .download(contract.file_url);

    console.log("[analyze] Download:", { size: fileBlob?.size, error: downloadError?.message });

    if (downloadError || !fileBlob) {
      return res.status(502).json({ error: "Could not retrieve contract file" });
    }

    // Empty file — treat as parse failure, not a hard error
    if (fileBlob.size === 0) {
      console.warn("[analyze] File is empty:", contract_id);
      return res.status(200).json(parseFailed("File is empty"));
    }

    // ── Extract PDF text ──────────────────────────────────────────────────────
    let extractedText = "";
    let parser: InstanceType<typeof PDFParse> | null = null;
    try {
      const arrayBuffer = await fileBlob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log("[analyze] Parsing PDF, buffer size:", buffer.length);

      parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      extractedText = parsed.text?.trim() ?? "";
      console.log("[analyze] Extracted text length:", extractedText.length);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : "Unknown parse error";
      console.error("[analyze] pdf-parse failed:", reason);
    } finally {
      if (parser) await parser.destroy().catch(() => {});
    }

    // Scanned or unreadable PDF — return graceful response, never error
    if (!extractedText) {
      console.warn("[analyze] No text extracted from PDF:", contract_id);
      return res.status(200).json(parseFailed("No extractable text — may be a scanned image"));
    }

    // ── Trim to token budget ──────────────────────────────────────────────────
    const trimmedText = extractedText.length > MAX_TEXT_CHARS
      ? extractedText.slice(0, MAX_TEXT_CHARS)
      : extractedText;

    const wasTrimmed = extractedText.length > MAX_TEXT_CHARS;

    console.log("RESULT:", {
      contract_id,
      char_count: trimmedText.length,
      was_trimmed: wasTrimmed,
      include_redlines,
    });

    // ── TODO: AI_ANALYSIS_HOOK ────────────────────────────────────────────────
    // Replace the stub below with a real LLM call.
    // Inputs available:
    //   trimmedText    — full PDF text, trimmed to MAX_TEXT_CHARS
    //   include_redlines — boolean, whether user wants redline suggestions
    //   contract_id    — UUID of the contract
    // Expected output shape:
    //   { summary: string, risks: string[], clauses: string[], risk_score: number }
    // ─────────────────────────────────────────────────────────────────────────
    const analysisResult = {
      summary: null as string | null,
      risks: [] as string[],
      clauses: [] as string[],
      risk_score: null as number | null,
    };

    // ── Response ──────────────────────────────────────────────────────────────
    return res.status(200).json({
      contract_id,
      filename: contract.filename ?? contract.file_url,
      extracted_text: trimmedText,
      char_count: trimmedText.length,
      was_trimmed: wasTrimmed,
      include_redlines,
      ...analysisResult,
    });

  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : "unknown";
    console.error("ANALYZE ERROR:", err);
    return res.status(500).json({ error: "Analysis failed", reason });
  }
}
