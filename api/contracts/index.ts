/**
 * GET /api/contracts
 *
 * Returns the authenticated user's contracts, ordered by most recent first.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getUserIdFromToken, getServiceClient } from "../../lib/server/supabase";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = (req.headers?.authorization as string) ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  let userId: string;
  try {
    userId = await getUserIdFromToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  try {
    const db = getServiceClient();
    const { data, error } = await db
      .from("contracts")
      .select(
        "id, filename, file_size, status, created_at, risk_score, clause_count, latest_analysis_id, latest_analysis_status",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("[contracts] Query error:", error.message);
      return res.status(500).json({ error: "Could not retrieve contracts." });
    }

    const contracts = (data ?? []).map((c) => ({
      id: c.id as string,
      name: (c.filename as string | null) ?? "Untitled",
      file_size: (c.file_size as number | null) ?? 0,
      status: (c.status as string | null) ?? "uploaded",
      created_at: c.created_at as string,
      risk_score: (c.risk_score as number | null) ?? null,
      high_risk_count: null,
      clause_count: (c.clause_count as number | null) ?? null,
      latest_analysis_id: (c.latest_analysis_id as string | null) ?? null,
      latest_analysis_status: (c.latest_analysis_status as string | null) ?? null,
    }));

    return res.status(200).json(contracts);
  } catch (err: unknown) {
    console.error("[contracts] Fatal:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Could not retrieve contracts." });
  }
}
