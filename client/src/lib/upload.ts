/**
 * handleUpload — Supabase Storage + contracts table
 *
 * 1. Uploads file to the "contracts" private bucket
 *    Path: {userId}/{timestamp}-{sanitized-filename}
 * 2. Inserts a row in the "contracts" table:
 *    { user_id, file_url, filename, file_size, status: "uploaded" }
 * 3. Returns { contract_id, file_url, filename, file_size }
 *
 * Mock mode (VITE_USE_MOCK=true) short-circuits everything — no network calls.
 */

import { supabase } from "@/lib/supabase";
import { USE_MOCK } from "@/lib/api";

export interface UploadResult {
  contract_id: string;
  file_url: string;
  filename: string;
  file_size: number;
  status: string;
}

export async function handleUpload(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<UploadResult> {
  // ── Mock mode ────────────────────────────────────────────────────────────────
  if (USE_MOCK) {
    for (let p = 0; p <= 100; p += 25) {
      await new Promise((r) => setTimeout(r, 120));
      onProgress?.(p);
    }
    return {
      contract_id: "mock-contract-id",
      file_url: `mock-user/0-${file.name}`,
      filename: file.name,
      file_size: file.size,
      status: "uploaded",
    };
  }

  // ── Auth check ───────────────────────────────────────────────────────────────
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError || !session) {
    throw new Error("You must be logged in to upload a contract.");
  }

  const userId = session.user.id;

  // ── Build storage path ───────────────────────────────────────────────────────
  // Sanitize filename: replace everything except alphanumerics, dots, hyphens
  const sanitized = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = `${userId}/${Date.now()}-${sanitized}`;

  // ── Upload to Supabase Storage ───────────────────────────────────────────────
  onProgress?.(0);
  const { error: storageError } = await supabase.storage
    .from("contracts")
    .upload(filePath, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false, // reject duplicate paths — timestamp makes this nearly impossible
    });
  onProgress?.(70);

  if (storageError) {
    throw new Error(`Storage error: ${storageError.message}`);
  }

  // ── Save to contracts table ───────────────────────────────────────────────────
  const { data: row, error: dbError } = await supabase
    .from("contracts")
    .insert({
      user_id: userId,
      file_url: filePath,
      filename: file.name,
      file_size: file.size,
      status: "uploaded",
    })
    .select("id")
    .single();

  if (dbError) {
    // Attempt to clean up the uploaded file so storage doesn't orphan it
    await supabase.storage.from("contracts").remove([filePath]);
    throw new Error(`Database error: ${dbError.message}`);
  }

  onProgress?.(100);

  return {
    contract_id: row.id as string,
    file_url: filePath,
    filename: file.name,
    file_size: file.size,
    status: "uploaded",
  };
}
