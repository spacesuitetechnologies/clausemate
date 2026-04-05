/**
 * Text extraction pipeline: PDF → DOCX → TXT → image → AI OCR fallback.
 * Caches extracted text in Supabase `contract_text_cache` table.
 *
 * Required Supabase table (create if missing):
 *   CREATE TABLE IF NOT EXISTS contract_text_cache (
 *     contract_id uuid PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
 *     extracted_text text NOT NULL,
 *     char_count integer NOT NULL,
 *     created_at timestamptz DEFAULT now()
 *   );
 */

import { getServiceClient } from "./supabase";

const MAX_TEXT_CHARS = 40_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
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

// ── AI OCR ────────────────────────────────────────────────────────────────────

async function aiOCR(
  buffer: Buffer,
  mimeType: "application/pdf" | "image/jpeg" | "image/png",
): Promise<string> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error("OPENAI_API_KEY not set — AI OCR unavailable");

  const ext = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
  const formData = new FormData();
  formData.append("purpose", "assistants");
  formData.append("file", new Blob([buffer], { type: mimeType }), `document.${ext}`);

  const uploadRes = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: formData,
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => "");
    throw new Error(`OpenAI file upload failed ${uploadRes.status}: ${err.slice(0, 200)}`);
  }
  const { id: fileId } = await uploadRes.json() as { id: string };

  const ocrRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Extract all readable text from this contract." },
            { type: "input_file", file_id: fileId },
          ],
        },
      ],
    }),
  });
  if (!ocrRes.ok) {
    const err = await ocrRes.text().catch(() => "");
    throw new Error(`AI OCR error ${ocrRes.status}: ${err.slice(0, 200)}`);
  }

  const data = await ocrRes.json();
  const text: string =
    data.output_text ||
    (Array.isArray(data.output)
      ? data.output
          .map((o: { content?: Array<{ text?: string }> }) =>
            Array.isArray(o.content) ? o.content.map((c) => c.text || "").join("") : "",
          )
          .join("")
      : "") ||
    "";

  return text.trim();
}

// ── Core extraction ───────────────────────────────────────────────────────────

async function extractFromBlob(blob: Blob, filename: string): Promise<string> {
  if (blob.size > MAX_FILE_BYTES) {
    throw new ExtractionError(
      `File is too large (${(blob.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 10 MB.`,
    );
  }

  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const isPdf = ext === "pdf" || filename.toLowerCase().includes(".pdf");
  const isDocx = ext === "docx";
  const isTxt = ext === "txt";
  const isImage = ["jpg", "jpeg", "png", "webp", "bmp", "tiff"].includes(ext);

  let text = "";

  if (isPdf) {
    try {
      const pdfModule = await import("pdf-parse");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfParse = (pdfModule as any).default ?? pdfModule;
      const parsed = await pdfParse(buffer);
      text = parsed?.text?.trim() ?? "";
    } catch (err) {
      console.warn("[extract] pdf-parse failed:", err instanceof Error ? err.message : err);
    }

    if (!text || text.length < 50) {
      try {
        text = await aiOCR(buffer, "application/pdf");
      } catch (err) {
        console.warn("[extract] AI OCR failed:", err instanceof Error ? err.message : err);
      }
    }
  } else if (isDocx) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      text = result.value?.trim() ?? "";
    } catch (err) {
      console.warn("[extract] mammoth failed:", err instanceof Error ? err.message : err);
    }
  } else if (isTxt) {
    text = buffer.toString("utf-8").trim();
  } else if (isImage) {
    const imgMime = ext === "png" ? "image/png" : "image/jpeg";
    try {
      text = await aiOCR(buffer, imgMime as "image/png" | "image/jpeg");
    } catch (err) {
      console.warn("[extract] image OCR failed:", err instanceof Error ? err.message : err);
    }
  } else {
    text = buffer.toString("utf-8").trim();
  }

  return text;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ExtractResult {
  text: string;
  trimmedText: string;
  wasTrimmed: boolean;
  fromCache: boolean;
}

export async function extractContractText(
  contractId: string,
  fileUrl: string,
  filename: string,
): Promise<ExtractResult> {
  // Check cache first
  const cached = await getCachedText(contractId);
  if (cached && cached.length > 50) {
    const trimmedText = cached.length > MAX_TEXT_CHARS ? cached.slice(0, MAX_TEXT_CHARS) : cached;
    return { text: cached, trimmedText, wasTrimmed: cached.length > MAX_TEXT_CHARS, fromCache: true };
  }

  // Download from Supabase Storage
  const { data: blob, error: downloadError } = await getServiceClient()
    .storage.from("contracts")
    .download(fileUrl);

  if (downloadError || !blob) {
    throw new ExtractionError("Could not retrieve the uploaded file. Please try again.");
  }

  if (blob.size === 0) {
    throw new ExtractionError("The uploaded file is empty.");
  }

  const text = await extractFromBlob(blob, filename);

  if (!text || text.trim().length === 0) {
    throw new ExtractionError(
      "Could not extract text from this document. It may be a scanned image that OCR could not read.",
    );
  }

  // Cache in background — don't block on failure
  cacheText(contractId, text).catch(() => {});

  const trimmedText = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  return { text, trimmedText, wasTrimmed: text.length > MAX_TEXT_CHARS, fromCache: false };
}
