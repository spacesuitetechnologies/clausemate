/**
 * Text extraction pipeline: PDF → DOCX → TXT → image → AI OCR fallback.
 * Caches extracted text per contract.
 * Returns file hash (SHA-256 of raw bytes) for upstream deduplication.
 *
 * Required Supabase table (create if missing):
 *   CREATE TABLE IF NOT EXISTS contract_text_cache (
 *     contract_id uuid PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
 *     extracted_text text NOT NULL,
 *     char_count integer NOT NULL,
 *     created_at timestamptz DEFAULT now()
 *   );
 */

import { createHash } from "node:crypto";
import { getServiceClient } from "./supabase";
import { log, warn } from "./logger";


const MAX_TEXT_CHARS = 40_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const OCR_TIMEOUT_MS = 30_000;

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

// ── File hash ─────────────────────────────────────────────────────────────────

export function hashFileBytes(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ── Text cache ────────────────────────────────────────────────────────────────

async function getCachedText(contractId: string): Promise<string | null> {
  try {
    const { data, error } = await getServiceClient()
      .from("contract_text_cache")
      .select("extracted_text")
      .eq("contract_id", contractId)
      .maybeSingle();
    if (error || !data) return null;
    return data.extracted_text as string;
  } catch {
    return null;
  }
}

async function cacheText(contractId: string, text: string): Promise<void> {
  try {
    await getServiceClient()
      .from("contract_text_cache")
      .upsert(
        { contract_id: contractId, extracted_text: text, char_count: text.length },
        { onConflict: "contract_id" },
      );
  } catch {
    // Non-fatal — table may not exist yet
  }
}

// ── Abort helper ──────────────────────────────────────────────────────────────

function makeAbortSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// ── OCR quality detection ─────────────────────────────────────────────────────

/**
 * Returns true if extracted text is too low quality to use.
 * Handles: scanned PDFs, stamp paper documents, garbled encoding.
 */
export function isTextQualityPoor(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 100) return true;

  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 20) return true;

  // High ratio of non-printable / control chars = garbled encoding or image noise
  const nonPrintable = (trimmed.match(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g) ?? []).length;
  if (nonPrintable / trimmed.length > 0.15) return true;

  // Average word length outside realistic range for English legal text
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / words.length;
  if (avgWordLen < 2.5 || avgWordLen > 18) return true;

  // No punctuation at all — likely noise or pure number/code dump
  const hasPunctuation = /[.,;:()"'\/\-]/.test(trimmed);
  if (!hasPunctuation) return true;

  // High ratio of single-char "words" (OCR noise) — excluding "a", "I"
  const singleCharNoise = words.filter((w) => w.length === 1 && !/[aAiI]/.test(w)).length;
  if (singleCharNoise / words.length > 0.3) return true;

  // Insufficient lexical diversity
  const uniqueWords = new Set(words.map((w) => w.toLowerCase())).size;
  if (uniqueWords < 15) return true;

  return false;
}

// ── AI OCR ────────────────────────────────────────────────────────────────────

async function ocrWithAnthropic(buffer: Buffer, mimeType: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const base64 = buffer.toString("base64");
  const { signal, clear } = makeAbortSignal(OCR_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: mimeType, data: base64 },
              },
              {
                type: "text",
                text: "Extract ALL readable text from this document. Output only the raw text, preserving paragraphs and headings. Do not add commentary.",
              },
            ],
          },
        ],
      }),
      signal,
    });
    clear();

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Anthropic OCR ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    return data.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
  } catch (e) {
    clear();
    throw e;
  }
}

async function ocrWithOpenAI(buffer: Buffer, mimeType: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const base64 = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const { signal, clear } = makeAbortSignal(OCR_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
              {
                type: "text",
                text: "Extract ALL readable text from this document image. Output only the raw text, preserving paragraphs. Do not add commentary.",
              },
            ],
          },
        ],
      }),
      signal,
    });
    clear();

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenAI OCR ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (e) {
    clear();
    throw e;
  }
}

async function runOCR(
  buffer: Buffer,
  mimeType: string,
  isPdf: boolean,
  context: { contractId: string },
): Promise<string> {
  log("extract", "OCR starting", { contractId: context.contractId, mimeType, isPdf });

  // PDFs: Anthropic handles them natively as base64 documents
  if (isPdf && process.env.ANTHROPIC_API_KEY) {
    try {
      const text = await ocrWithAnthropic(buffer, "application/pdf");
      if (text.length > 50) {
        log("extract", "OCR succeeded (Anthropic PDF)", { contractId: context.contractId, charCount: text.length });
        return text;
      }
    } catch (e) {
      warn("extract", "Anthropic PDF OCR failed", { contractId: context.contractId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Images: OpenAI vision (base64 image_url)
  if (!isPdf && process.env.OPENAI_API_KEY) {
    try {
      const text = await ocrWithOpenAI(buffer, mimeType);
      if (text.length > 20) {
        log("extract", "OCR succeeded (OpenAI image)", { contractId: context.contractId, charCount: text.length });
        return text;
      }
    } catch (e) {
      warn("extract", "OpenAI image OCR failed", { contractId: context.contractId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Last resort for images: Anthropic vision
  if (!isPdf && process.env.ANTHROPIC_API_KEY) {
    try {
      const text = await ocrWithAnthropic(buffer, mimeType);
      if (text.length > 20) {
        log("extract", "OCR succeeded (Anthropic image)", { contractId: context.contractId, charCount: text.length });
        return text;
      }
    } catch (e) {
      warn("extract", "Anthropic image OCR fallback failed", { contractId: context.contractId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  warn("extract", "OCR produced no usable text", { contractId: context.contractId });
  return "";
}

// ── Text normalization ────────────────────────────────────────────────────────

function normalizeText(raw: string): string {
  return raw
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .split("\n").map((l) => l.trimEnd()).join("\n")
    .trim();
}

// ── Core extraction ───────────────────────────────────────────────────────────

async function extractFromBuffer(
  buffer: Buffer,
  filename: string,
  contractId: string,
): Promise<{ text: string; ocrUsed: boolean }> {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const isPdf  = ext === "pdf";
  const isDocx = ext === "docx";
  const isTxt  = ext === "txt";
  const isImage = ["jpg", "jpeg", "png", "webp", "bmp"].includes(ext);

  let text = "";
  let ocrUsed = false;

  if (isPdf) {
    try {
      const pdfModule = await import("pdf-parse");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfParse = (pdfModule as any).default ?? pdfModule;
      const parsed = await pdfParse(buffer);
      text = parsed?.text?.trim() ?? "";
    } catch (e) {
      warn("extract", "pdf-parse failed", { contractId, error: e instanceof Error ? e.message : String(e) });
    }

    if (isTextQualityPoor(text)) {
      log("extract", "PDF text quality poor — triggering OCR", {
        contractId,
        charCount: text.length,
        reason: text.length < 100 ? "too short" : "quality check failed",
      });
      const ocr = await runOCR(buffer, "application/pdf", true, { contractId });
      if (ocr.length > text.length) {
        text = ocr;
        ocrUsed = true;
      }
    }
  } else if (isDocx) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      text = result.value?.trim() ?? "";
    } catch (e) {
      warn("extract", "mammoth failed", { contractId, error: e instanceof Error ? e.message : String(e) });
    }
  } else if (isTxt) {
    text = buffer.toString("utf-8").trim();
  } else if (isImage) {
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg",
      png: "image/png", webp: "image/webp", bmp: "image/bmp",
    };
    text = await runOCR(buffer, mimeMap[ext] ?? "image/jpeg", false, { contractId });
    ocrUsed = text.length > 0;
  } else {
    text = buffer.toString("utf-8").trim();
  }

  return { text: normalizeText(text), ocrUsed };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ExtractResult {
  text: string;
  trimmedText: string;
  wasTrimmed: boolean;
  fromCache: boolean;
  /** SHA-256 of raw file bytes — used for file-level deduplication */
  fileHash: string;
  /** Whether AI OCR was invoked */
  ocrUsed: boolean;
}

export async function extractContractText(
  contractId: string,
  fileUrl: string,
  filename: string,
): Promise<ExtractResult> {
  // ── Text cache check ────────────────────────────────────────────────────────
  const cached = await getCachedText(contractId);
  if (cached && cached.length > 50) {
    log("extract", "Text cache hit", { contractId, charCount: cached.length });
    const trimmedText = cached.length > MAX_TEXT_CHARS ? cached.slice(0, MAX_TEXT_CHARS) : cached;
    return {
      text: cached,
      trimmedText,
      wasTrimmed: cached.length > MAX_TEXT_CHARS,
      fromCache: true,
      fileHash: hashFileBytes(Buffer.from(cached)), // approximate when from text cache
      ocrUsed: false,
    };
  }

  log("extract", "Downloading contract file", { contractId, filename });

  // ── Download ────────────────────────────────────────────────────────────────
  const { data: blob, error: downloadError } = await getServiceClient()
    .storage.from("contracts")
    .download(fileUrl);

  if (downloadError || !blob) {
    throw new ExtractionError("Could not retrieve the uploaded file. Please re-upload and try again.");
  }

  if (blob.size === 0) {
    throw new ExtractionError("The uploaded file is empty.");
  }

  if (blob.size > MAX_FILE_BYTES) {
    throw new ExtractionError(
      `File is too large (${(blob.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 10 MB.`,
    );
  }

  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const fileHash = hashFileBytes(buffer);

  log("extract", "File downloaded", { contractId, filename, bytes: blob.size, fileHash: fileHash.slice(0, 8) });

  // ── Extract ─────────────────────────────────────────────────────────────────
  const { text, ocrUsed } = await extractFromBuffer(buffer, filename, contractId);

  if (!text || text.length < 30) {
    throw new ExtractionError(
      "Could not extract text from this document. It may be a heavily protected PDF or unsupported scan format. Please try a text-based version.",
    );
  }

  log("extract", "Extraction complete", {
    contractId,
    charCount: text.length,
    ocrUsed,
    fileHash: fileHash.slice(0, 8),
  });

  // Cache in background
  cacheText(contractId, text).catch(() => {});

  const trimmedText = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  return {
    text,
    trimmedText,
    wasTrimmed: text.length > MAX_TEXT_CHARS,
    fromCache: false,
    fileHash,
    ocrUsed,
  };
}

