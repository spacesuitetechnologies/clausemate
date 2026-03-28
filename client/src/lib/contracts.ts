/**
 * contracts.ts — Supabase data layer for the contracts table + storage.
 *
 * fetchUserContracts()        → SELECT from contracts, ordered by created_at DESC
 * getSignedUrl(filePath)      → generate a 60-second signed URL for a storage path
 * getSignedUrlById(id)        → look up file_url by contract id, then sign it
 *
 * Mock mode (VITE_USE_MOCK=true) delegates to api.fetchContracts so development
 * works without a Supabase project.
 */

import { supabase } from "@/lib/supabase";
import type { ContractSummary } from "@/types/analysis";

const SIGNED_URL_TTL = 60; // seconds

// Cache signed URLs for 55 s (5 s buffer before Supabase expiry at 60 s)
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

// ── Fetch contracts ───────────────────────────────────────────────────────────

export async function fetchUserContracts(): Promise<ContractSummary[]> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError || !session) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .from("contracts")
    .select(
      "id, filename, file_url, file_size, status, created_at, risk_score, clause_count, latest_analysis_id, latest_analysis_status",
    )
    .eq("user_id", session.user.id)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.filename ?? row.file_url,       // filename is the display name
    file_size: row.file_size ?? 0,
    status: row.status,
    created_at: row.created_at,
    risk_score: row.risk_score ?? null,
    clause_count: row.clause_count ?? null,
    latest_analysis_id: row.latest_analysis_id ?? null,
    latest_analysis_status: row.latest_analysis_status ?? null,
  }));
}

// ── Signed URLs ───────────────────────────────────────────────────────────────

/**
 * Generate a signed URL for a known storage path.
 * Valid for SIGNED_URL_TTL seconds.
 * Use this when you already have the file path.
 */
export async function getSignedUrl(filePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from("contracts")
    .createSignedUrl(filePath, SIGNED_URL_TTL);

  if (error) throw new Error(`Could not generate link: ${error.message}`);
  if (!data?.signedUrl) throw new Error("Supabase returned no signed URL");

  return data.signedUrl;
}

/**
 * Look up the file_url for a contract by id, then sign it.
 * Results are cached for 55 s to prevent redundant Supabase calls on rapid clicks.
 */
export async function getSignedUrlById(contractId: string): Promise<string> {
  const cached = signedUrlCache.get(contractId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const { data, error } = await supabase
    .from("contracts")
    .select("file_url")
    .eq("id", contractId)
    .single();

  if (error || !data?.file_url) {
    throw new Error("Contract not found or missing file path");
  }

  const url = await getSignedUrl(data.file_url);
  signedUrlCache.set(contractId, { url, expiresAt: Date.now() + 55_000 });
  return url;
}
