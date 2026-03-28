import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// ── Env vars ─────────────────────────────────────────────────────────────────
// SUPABASE_ANON_KEY   — used for JWT validation (public, safe in edge functions)
// SUPABASE_SERVICE_ROLE_KEY — used for storage download (secret, server-only)
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// Max characters to pass to LLM — trim very long contracts to control token cost
const MAX_TEXT_CHARS = 40_000;

// ── In-memory rate limit store ────────────────────────────────────────────────
// Tracks last request timestamp per user. Resets on function cold-start (acceptable).
const lastRequestAt = new Map<string, number>();
const RATE_LIMIT_MS = 5_000; // 1 request per 5 seconds per user

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ── Config check ─────────────────────────────────────────────────────────────
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    console.error("[analyze] Missing required env vars");
    return res.status(500).json({ error: "Server configuration error" });
  }

  // ── Auth validation ──────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing authorization token" });
  }

  const anonClient = createClient(supabaseUrl, supabaseAnonKey);
  const {
    data: { user },
    error: authError,
  } = await anonClient.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────────
  const now = Date.now();
  const last = lastRequestAt.get(user.id) ?? 0;
  if (now - last < RATE_LIMIT_MS) {
    return res.status(429).json({ error: "Too many requests. Please wait before analyzing again." });
  }
  lastRequestAt.set(user.id, now);

  // ── Input validation ─────────────────────────────────────────────────────────
  const { contract_id, include_redlines } = req.body ?? {};
  const includeRedlines = include_redlines === true;

  if (!contract_id || typeof contract_id !== "string") {
    return res.status(400).json({ error: "contract_id is required" });
  }

  // ── Fetch contract (ownership enforced via user_id filter) ───────────────────
  const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

  const { data: contract, error: contractError } = await serviceClient
    .from("contracts")
    .select("file_url, filename")
    .eq("id", contract_id)
    .eq("user_id", user.id)
    .single();

  if (contractError || !contract) {
    return res.status(404).json({ error: "Contract not found" });
  }

  // ── Download file from Supabase Storage ──────────────────────────────────────
  const { data: fileBlob, error: downloadError } = await serviceClient.storage
    .from("contracts")
    .download(contract.file_url);

  if (downloadError || !fileBlob) {
    console.error("[analyze] Storage download failed:", downloadError?.message);
    return res.status(502).json({ error: "Could not retrieve contract file" });
  }

  // ── Extract PDF text ─────────────────────────────────────────────────────────
  let extractedText: string;
  try {
    const pdfModule = await import("pdf-parse");
    const pdfParse = (pdfModule as any).default || pdfModule;
    const buffer = Buffer.from(await fileBlob.arrayBuffer());
    const parsed = await pdfParse(buffer);
    extractedText = parsed.text?.trim() ?? "";
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown parse error";
    console.error("[analyze] pdf-parse failed:", message);
    return res
      .status(422)
      .json({ error: "Could not parse PDF — file may be corrupted or password-protected" });
  }

  if (!extractedText) {
    return res.status(422).json({
      error:
        "PDF contains no extractable text — it may be a scanned image. Please upload a text-based PDF.",
    });
  }

  // Trim to token budget (LLM integration will use this field)
  const trimmedText =
    extractedText.length > MAX_TEXT_CHARS
      ? extractedText.slice(0, MAX_TEXT_CHARS)
      : extractedText;

  const wasTrimmed = extractedText.length > MAX_TEXT_CHARS;

  // ── Return extracted text (LLM call wired up in next step) ───────────────────
  return res.status(200).json({
    contract_id,
    filename: contract.filename ?? contract.file_url,
    extracted_text: trimmedText,
    char_count: trimmedText.length,
    was_trimmed: wasTrimmed,
    include_redlines: includeRedlines,
    // Analysis fields — populated once LLM is integrated
    summary: null,
    risks: [] as string[],
    clauses: [] as string[],
    risk_score: null,
  });
}
