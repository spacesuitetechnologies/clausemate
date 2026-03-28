import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = require("pdf-parse");

// ── Env vars ─────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// Max characters to pass to LLM
const MAX_TEXT_CHARS = 40_000;

// ── In-memory rate limit store ────────────────────────────────────────────────
const lastRequestAt = new Map<string, number>();
const RATE_LIMIT_MS = 5_000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // ── Config check ───────────────────────────────────────────────────────────
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      console.error("[analyze] Missing required env vars");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // ── Auth validation ────────────────────────────────────────────────────────
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

    // ── Rate limiting ──────────────────────────────────────────────────────────
    const now = Date.now();
    const last = lastRequestAt.get(user.id) ?? 0;
    if (now - last < RATE_LIMIT_MS) {
      return res.status(429).json({ error: "Too many requests. Please wait before analyzing again." });
    }
    lastRequestAt.set(user.id, now);

    // ── Input validation ───────────────────────────────────────────────────────
    console.log("REQ BODY:", req.body);

    const body = req.body || {};
    const contract_id = body.contract_id;
    const include_redlines = body.include_redlines === true;

    console.log("Analyze request:", { contract_id, include_redlines });

    if (!contract_id || typeof contract_id !== "string") {
      return res.status(400).json({ error: "Invalid contract_id" });
    }

    // ── Fetch contract ─────────────────────────────────────────────────────────
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

    // ── File type guard ────────────────────────────────────────────────────────
    const filePath: string = contract.file_url ?? "";
    if (!filePath.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ error: "Invalid file type. Only PDF allowed." });
    }

    // ── Download file ──────────────────────────────────────────────────────────
    const { data: fileBlob, error: downloadError } = await serviceClient.storage
      .from("contracts")
      .download(contract.file_url);

    console.log("[analyze] Download:", { size: fileBlob?.size, error: downloadError?.message });

    if (downloadError || !fileBlob) {
      return res.status(502).json({ error: "Could not retrieve contract file" });
    }

    if (fileBlob.size === 0) {
      return res.status(422).json({ error: "File is empty. Cannot analyze." });
    }

    // ── Extract PDF text ───────────────────────────────────────────────────────
    let extractedText: string;
    try {
      const arrayBuffer = await fileBlob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log("[analyze] Parsing PDF, buffer size:", buffer.length);
      const parsed = await pdfParse(buffer);
      extractedText = parsed.text?.trim() ?? "";
      console.log("[analyze] Extracted text length:", extractedText.length);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : "Unknown parse error";
      console.error("[analyze] pdf-parse failed:", reason);
      return res.status(422).json({ error: "Failed to parse PDF", reason });
    }

    if (!extractedText) {
      return res.status(422).json({ error: "PDF contains no extractable text. It may be a scanned image." });
    }

    // ── Trim to token budget ───────────────────────────────────────────────────
    const trimmedText = extractedText.length > MAX_TEXT_CHARS
      ? extractedText.slice(0, MAX_TEXT_CHARS)
      : extractedText;

    const wasTrimmed = extractedText.length > MAX_TEXT_CHARS;

    // ── Response ───────────────────────────────────────────────────────────────
    return res.status(200).json({
      contract_id,
      filename: contract.filename ?? contract.file_url,
      extracted_text: trimmedText,
      char_count: trimmedText.length,
      was_trimmed: wasTrimmed,
      include_redlines,
      summary: null,
      risks: [] as string[],
      clauses: [] as string[],
      risk_score: null,
    });

  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : "unknown";
    console.error("ANALYZE ERROR:", err);
    return res.status(500).json({ error: "Analysis failed", reason });
  }
}
