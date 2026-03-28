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

// ── Safe fallback response — always valid shape ───────────────────────────────
function safeExit(error: string, detail?: string) {
  return {
    summary: "Could not process file.",
    risks: [] as string[],
    clauses: [] as string[],
    risk_score: null as number | null,
    error,
    parse_fail_reason: detail ?? error,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    console.log("STEP: handler start");
    console.log("BODY:", req.body);

    // ── Method guard ──────────────────────────────────────────────────────────
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed", summary: "", risks: [], clauses: [] });
    }

    // ── Config check ──────────────────────────────────────────────────────────
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      console.error("[analyze] Missing env vars: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
      return res.status(200).json(safeExit("CONFIG_ERROR", "Server misconfigured"));
    }

    // ── Auth validation ───────────────────────────────────────────────────────
    console.log("STEP: auth check");
    const authHeader = req.headers?.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing authorization token", summary: "", risks: [], clauses: [] });
    }

    let user: { id: string } | null = null;
    try {
      const anonClient = createClient(supabaseUrl, supabaseAnonKey);
      const { data, error: authError } = await anonClient.auth.getUser(token);
      if (authError || !data?.user) {
        return res.status(401).json({ error: "Invalid or expired token", summary: "", risks: [], clauses: [] });
      }
      user = data.user;
    } catch (authEx: unknown) {
      const msg = authEx instanceof Error ? authEx.message : "Auth exception";
      console.error("[analyze] Auth exception:", msg);
      return res.status(401).json({ error: "Auth failed", summary: "", risks: [], clauses: [] });
    }

    // ── Rate limiting ─────────────────────────────────────────────────────────
    const now = Date.now();
    const last = lastRequestAt.get(user.id) ?? 0;
    if (now - last < RATE_LIMIT_MS) {
      return res.status(429).json({ error: "Too many requests. Please wait before analyzing again.", summary: "", risks: [], clauses: [] });
    }
    lastRequestAt.set(user.id, now);

    // ── Input validation ──────────────────────────────────────────────────────
    console.log("STEP: input validation");
    const body = req.body ?? {};
    const contract_id: unknown = body.contract_id;
    const include_redlines: boolean = body.include_redlines === true;

    console.log("Analyze request:", { contract_id, include_redlines });

    if (!contract_id || typeof contract_id !== "string") {
      return res.status(400).json({ error: "Invalid contract_id", summary: "", risks: [], clauses: [] });
    }

    // ── Fetch contract (ownership enforced via user_id) ───────────────────────
    console.log("STEP: fetch contract", contract_id);
    let contract: { file_url: string; filename: string } | null = null;
    try {
      const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
      const { data, error: contractError } = await serviceClient
        .from("contracts")
        .select("file_url, filename")
        .eq("id", contract_id)
        .eq("user_id", user.id)
        .single();

      console.log("[analyze] Contract lookup:", { found: !!data, error: contractError?.message });

      if (contractError || !data) {
        return res.status(404).json({ error: "Contract not found", summary: "", risks: [], clauses: [] });
      }
      contract = data;
    } catch (dbEx: unknown) {
      const msg = dbEx instanceof Error ? dbEx.message : "DB exception";
      console.error("[analyze] Contract fetch exception:", msg);
      return res.status(200).json(safeExit("DB_ERROR", msg));
    }

    // ── File type guard ───────────────────────────────────────────────────────
    const filePath: string = contract.file_url ?? "";
    if (!filePath.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ error: "Invalid file type. Only PDF allowed.", summary: "", risks: [], clauses: [] });
    }

    // ── Download file from Supabase Storage ───────────────────────────────────
    console.log("STEP: download file", filePath);
    let fileBlob: Blob | null = null;
    try {
      const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
      const { data, error: downloadError } = await serviceClient.storage
        .from("contracts")
        .download(contract.file_url);

      console.log("[analyze] Download:", { size: data?.size, error: downloadError?.message });

      if (downloadError || !data) {
        console.error("[analyze] Download failed:", downloadError?.message);
        return res.status(200).json(safeExit("DOWNLOAD_ERROR", downloadError?.message ?? "Could not retrieve file"));
      }
      fileBlob = data;
    } catch (dlEx: unknown) {
      const msg = dlEx instanceof Error ? dlEx.message : "Download exception";
      console.error("[analyze] Download exception:", msg);
      return res.status(200).json(safeExit("DOWNLOAD_ERROR", msg));
    }

    console.log("FILE SIZE:", fileBlob?.size);

    if (!fileBlob) {
      return res.status(200).json(safeExit("DOWNLOAD_ERROR", "File blob is null"));
    }

    if (fileBlob.size === 0) {
      console.warn("[analyze] File is empty:", contract_id);
      return res.status(200).json(safeExit("PARSE_FAILED", "File is empty"));
    }

    // ── Extract PDF text ──────────────────────────────────────────────────────
    console.log("STEP: parse PDF");
    let extractedText = "";
    try {
      const arrayBuffer = await fileBlob.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        console.warn("[analyze] arrayBuffer empty");
        return res.status(200).json(safeExit("PARSE_FAILED", "File buffer is empty"));
      }
      const buffer = Buffer.from(arrayBuffer);
      console.log("[analyze] Parsing PDF, buffer size:", buffer.length);

      let parser: InstanceType<typeof PDFParse> | null = null;
      try {
        parser = new PDFParse({ data: buffer });
        const parsed = await parser.getText();
        extractedText = parsed?.text?.trim() ?? "";
        console.log("TEXT LENGTH:", extractedText.length);
      } finally {
        if (parser) {
          try { await parser.destroy(); } catch {}
        }
      }
    } catch (parseEx: unknown) {
      const reason = parseEx instanceof Error ? parseEx.message : "Unknown parse error";
      console.error("[analyze] pdf-parse failed:", reason);
      return res.status(200).json(safeExit("PARSE_FAILED", reason));
    }

    if (!extractedText) {
      console.warn("[analyze] No text extracted from PDF:", contract_id);
      return res.status(200).json(safeExit("PARSE_FAILED", "No extractable text — may be a scanned image"));
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
    //   trimmedText      — full PDF text, trimmed to MAX_TEXT_CHARS
    //   include_redlines — boolean, whether user wants redline suggestions
    //   contract_id      — UUID of the contract
    // Expected output shape:
    //   { summary: string, risks: string[], clauses: string[], risk_score: number }
    // ─────────────────────────────────────────────────────────────────────────
    const analysisResult = {
      summary: "" as string,
      risks: [] as string[],
      clauses: [] as string[],
      risk_score: null as number | null,
    };

    // ── Response ──────────────────────────────────────────────────────────────
    return res.status(200).json({
      contract_id,
      filename: contract.filename ?? contract.file_url ?? "",
      extracted_text: trimmedText,
      char_count: trimmedText.length,
      was_trimmed: wasTrimmed,
      include_redlines,
      ...analysisResult,
    });

  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : "UNKNOWN_ERROR";
    console.error("FATAL ANALYZE ERROR:", err);
    return res.status(200).json({
      summary: "Analysis failed due to internal error.",
      risks: [],
      clauses: [],
      risk_score: null,
      error: reason,
    });
  }
}
