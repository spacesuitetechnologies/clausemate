import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { contract_id } = req.body ?? {};

  if (!contract_id) {
    return res.status(400).json({ error: "contract_id is required" });
  }

  return res.status(200).json({
    summary: "This is a sample contract summary.",
    risks: ["Payment delay risk", "Termination clause unclear"],
    clauses: ["Payment terms", "Liability clause"],
  });
}
