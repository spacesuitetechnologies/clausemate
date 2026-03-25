import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // POST /api/analyze — mock contract analysis endpoint
  app.post("/api/analyze", (req, res) => {
    const { contract_id } = req.body;

    if (!contract_id) {
      return res.status(400).json({ error: "contract_id is required" });
    }

    return res.json({
      summary: "This is a sample contract summary.",
      risks: ["Payment delay risk", "Termination clause unclear"],
      clauses: ["Payment terms", "Liability clause"],
    });
  });

  return httpServer;
}
