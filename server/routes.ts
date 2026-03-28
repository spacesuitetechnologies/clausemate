import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { createClient } from "@supabase/supabase-js";
import { storage } from "./storage";

// ── Supabase auth middleware ───────────────────────────────────────────────────

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Missing authorization token" });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const supabaseKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? "";

  if (!supabaseUrl || !supabaseKey) {
    // In local dev without Supabase configured, allow through but log a warning
    console.warn("[auth] SUPABASE_URL / SUPABASE_ANON_KEY not set — skipping JWT validation in dev");
    next();
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // POST /api/analyze — contract analysis endpoint (stub until LLM is wired up)
  app.post("/api/analyze", requireAuth, (req: Request, res: Response) => {
    const { contract_id } = req.body;

    if (!contract_id || typeof contract_id !== "string") {
      res.status(400).json({ error: "contract_id is required" });
      return;
    }

    res.json({
      summary: "This is a sample contract summary.",
      risks: ["Payment delay risk", "Termination clause unclear"],
      clauses: ["Payment terms", "Liability clause"],
      risk_score: 62,
    });
  });

  return httpServer;
}
