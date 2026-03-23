import { Router, Request, Response } from "express";
import multer from "multer";
import { createHash } from "crypto";
// file-type v16 uses a default export; fileTypeFromBuffer was added in v17+
import FileType from "file-type";
import { eq, and, desc, inArray, or, sql } from "drizzle-orm";
import { config } from "../config";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { authMiddleware } from "../middleware/auth";
import { getStorage } from "../services/storage";
import { logger } from "../services/logger";

const router = Router();

/* ── Multer Setup ─────────────────────────────────── */

// First-pass filter: rejects obviously wrong Content-Type headers before
// the buffer is fully read. The real enforcement is validateMagicBytes below.
const ALLOWED_DECLARED_MIMES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxFileSizeMb * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_DECLARED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, DOCX, and TXT files are allowed"));
    }
  },
});

/* ── Magic Byte Validation ────────────────────────── */
//
// The MIME type in the HTTP header is fully attacker-controlled — a renamed
// .exe with Content-Type: application/pdf bypasses header-only checks.
// Magic bytes are the first N bytes of the file itself; they cannot be faked
// without also making the file unreadable by its own parser.
//
// Approach:
//   - Binary formats (PDF, DOCX, DOC): fileTypeFromBuffer must detect the
//     exact expected signature. We use the detected MIME going forward —
//     not the client-supplied one — so the right parser is always invoked.
//   - Plain text: has no magic bytes by definition. fileTypeFromBuffer
//     returns undefined. We verify the declared MIME is text/plain, then
//     confirm the content is valid UTF-8 with no binary control characters.

// Magic-byte signatures we accept for binary formats.
const ALLOWED_BINARY_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);

type MagicBytesResult =
  | { ok: true; mimeType: string }
  | { ok: false; error: string };

async function validateMagicBytes(
  buffer: Buffer,
  declaredMime: string,
): Promise<MagicBytesResult> {
  const detected = await FileType.fromBuffer(buffer);

  if (detected) {
    // A binary signature was found — it must be in our allowlist.
    if (!ALLOWED_BINARY_MIMES.has(detected.mime)) {
      return {
        ok: false,
        error: `File content identified as '${detected.mime}'. Only PDF, DOCX, and TXT are accepted.`,
      };
    }
    // Return the detected (authoritative) MIME, not the client-supplied value.
    // This prevents a DOCX being stored with mimeType "application/pdf" and
    // later fed to the wrong parser.
    return { ok: true, mimeType: detected.mime };
  }

  // No binary signature — only valid when the client declared text/plain.
  if (declaredMime !== "text/plain") {
    return {
      ok: false,
      error: "File content does not match the declared type.",
    };
  }

  // Validate UTF-8 plain text: reject if >5% of bytes are non-printable
  // ASCII control characters (null bytes, escape sequences, etc.).
  // This catches binary files with no recognised magic bytes (e.g. encrypted
  // archives, custom formats) that would otherwise slip through as "text".
  const text = buffer.toString("utf8");
  const controlChars = (text.match(/[\x00-\x08\x0E-\x1F\x7F]/g) ?? []).length;
  if (buffer.length > 0 && controlChars / buffer.length > 0.05) {
    return {
      ok: false,
      error: "File does not appear to be valid plain text.",
    };
  }

  return { ok: true, mimeType: "text/plain" };
}

/* ── GET /contracts ───────────────────────────────── */
// List all contracts for the authenticated user with latest analysis summary.

router.get(
  "/",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;

      // 1. Fetch user's contracts, newest first
      const contractList = await db
        .select()
        .from(schema.contracts)
        .where(eq(schema.contracts.userId, userId))
        .orderBy(desc(schema.contracts.createdAt))
        .limit(50);

      if (contractList.length === 0) {
        res.json([]);
        return;
      }

      const contractIds = contractList.map((c) => c.id);

      // 2. Fetch all analyses for these contracts, newest first.
      // We track two views:
      //   - latestAnyByContract   : the most recent analysis (any status) for the status badge
      //   - latestCompletedByContract : the most recent *completed* analysis for risk/clause data
      const analysisList = await db
        .select()
        .from(schema.analyses)
        .where(inArray(schema.analyses.contractId, contractIds))
        .orderBy(desc(schema.analyses.startedAt));

      const latestAnyByContract = new Map<string, (typeof analysisList)[0]>();
      const latestCompletedByContract = new Map<string, (typeof analysisList)[0]>();
      for (const a of analysisList) {
        if (!latestAnyByContract.has(a.contractId)) {
          latestAnyByContract.set(a.contractId, a);
        }
        if (a.status === "completed" && !latestCompletedByContract.has(a.contractId)) {
          latestCompletedByContract.set(a.contractId, a);
        }
      }
      // Alias for existing downstream references that expected only completed analyses
      const latestByContract = latestCompletedByContract;

      const analysisIds = [...latestByContract.values()].map((a) => a.id);

      // 3. Count total clauses per analysis
      const clauseTotalMap = new Map<string, number>();
      // 4. Count high+critical clauses per analysis
      const highRiskMap = new Map<string, number>();

      if (analysisIds.length > 0) {
        const totalRows = await db
          .select({
            analysisId: schema.clauses.analysisId,
            total: sql<number>`cast(count(*) as integer)`,
          })
          .from(schema.clauses)
          .where(inArray(schema.clauses.analysisId, analysisIds))
          .groupBy(schema.clauses.analysisId);

        for (const row of totalRows) {
          clauseTotalMap.set(row.analysisId, Number(row.total));
        }

        const highRiskRows = await db
          .select({
            analysisId: schema.clauses.analysisId,
            total: sql<number>`cast(count(*) as integer)`,
          })
          .from(schema.clauses)
          .where(
            and(
              inArray(schema.clauses.analysisId, analysisIds),
              or(
                eq(schema.clauses.riskLevel, "high"),
                eq(schema.clauses.riskLevel, "critical"),
              ),
            ),
          )
          .groupBy(schema.clauses.analysisId);

        for (const row of highRiskRows) {
          highRiskMap.set(row.analysisId, Number(row.total));
        }
      }

      // 5. Build response
      const response = contractList.map((c) => {
        const completedAnalysis = latestByContract.get(c.id) ?? null;
        const latestAnalysis = latestAnyByContract.get(c.id) ?? null;
        const aId = completedAnalysis?.id ?? null;
        return {
          id: c.id,
          name: c.originalName,
          file_size: c.fileSize,
          status: c.status,
          created_at: c.createdAt.toISOString(),
          risk_score: completedAnalysis?.riskScore ?? null,
          high_risk_count: aId !== null ? (highRiskMap.get(aId) ?? 0) : null,
          clause_count: aId !== null ? (clauseTotalMap.get(aId) ?? 0) : null,
          latest_analysis_id: latestAnalysis?.id ?? null,
          latest_analysis_status: latestAnalysis?.status ?? null,
        };
      });

      res.json(response);
    } catch (error) {
      req.log.error({ err: error }, "List contracts error");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── POST /contracts/upload ───────────────────────── */

router.post(
  "/upload",
  authMiddleware,
  (req: Request, res: Response, next) => {
    upload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res
            .status(413)
            .json({ error: `File too large. Maximum size is ${config.maxFileSizeMb}MB` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      if (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const file = req.file;

      if (!file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      // Magic byte validation — must run before the buffer reaches any parser.
      // Uses the detected MIME (not the client-supplied one) for all subsequent
      // storage and DB operations so the correct parser is always invoked.
      const magicCheck = await validateMagicBytes(file.buffer, file.mimetype);
      if (!magicCheck.ok) {
        res.status(400).json({ error: magicCheck.error });
        return;
      }
      const verifiedMimeType = magicCheck.mimeType;

      // ── Duplicate detection ────────────────────────────
      // SHA-256 of the raw bytes is the canonical identity of the file content.
      // Checked per-user (not globally) so different users can upload the same
      // contract without colliding. Checked before writing to storage so we
      // never write a file we're going to reject.
      const fileHash = createHash("sha256").update(file.buffer).digest("hex");

      const [existing] = await db
        .select({ id: schema.contracts.id, status: schema.contracts.status })
        .from(schema.contracts)
        .where(
          and(
            eq(schema.contracts.userId, userId),
            eq(schema.contracts.fileHash, fileHash)
          )
        )
        .limit(1);

      if (existing) {
        req.log.info(
          { userId, contractId: existing.id },
          "upload.duplicate_rejected"
        );
        res.status(409).json({
          error: "This file has already been uploaded.",
          contract_id: existing.id,
          status: existing.status,
        });
        return;
      }

      const storage = getStorage();
      const storagePath = await storage.save(file.buffer, file.originalname, verifiedMimeType);

      const [contract] = await db
        .insert(schema.contracts)
        .values({
          userId,
          filename: storagePath.split("/").pop()!,
          originalName: file.originalname,
          fileSize: file.size,
          mimeType: verifiedMimeType,
          storagePath,
          fileHash,
          status: "uploaded",
        })
        .returning();

      res.status(201).json({
        contract_id: contract.id,
        filename: contract.originalName,
        file_size: contract.fileSize,
        mime_type: contract.mimeType,
        status: contract.status,
      });
    } catch (error) {
      req.log.error({ err: error }, "Upload error");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── GET /contracts/:id/analysis ──────────────────── */
// Returns the latest completed analysis for a contract (same shape as GET /analysis/:id).
// Must be declared BEFORE /:id to avoid param shadowing.

router.get(
  "/:id/analysis",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const contractId = req.params.id as string;

      // Verify contract belongs to user
      const [contract] = await db
        .select()
        .from(schema.contracts)
        .where(
          and(eq(schema.contracts.id, contractId), eq(schema.contracts.userId, userId)),
        )
        .limit(1);

      if (!contract) {
        res.status(404).json({ error: "Contract not found" });
        return;
      }

      // Get latest analysis for this contract (any status — caller handles non-completed states)
      const [analysis] = await db
        .select()
        .from(schema.analyses)
        .where(
          and(
            eq(schema.analyses.contractId, contractId),
            eq(schema.analyses.userId, userId),
          ),
        )
        .orderBy(desc(schema.analyses.startedAt))
        .limit(1);

      if (!analysis) {
        res.status(404).json({ error: "No analysis found for this contract" });
        return;
      }

      // Only fetch clauses for completed analyses — non-completed rows have none yet.
      const clauses =
        analysis.status === "completed"
          ? await db
              .select()
              .from(schema.clauses)
              .where(eq(schema.clauses.analysisId, analysis.id))
              .orderBy(schema.clauses.clauseNumber)
              .then((rows) =>
                rows.map((c) => ({
                  id: c.id,
                  clause_number: c.clauseNumber,
                  category: c.category,
                  title: c.title,
                  text: c.text,
                  risk_level: c.riskLevel,
                  score: c.score,
                  explanation: c.explanation ?? null,
                  suggested_rewrite: c.suggestedRewrite ?? null,
                  policy_violations: (c.policyViolations ?? []).map((v) => ({
                    explanation: v.explanation,
                  })),
                })),
              )
          : [];

      res.json({
        id: analysis.id,
        contract_id: analysis.contractId,
        contract_name: contract.originalName,
        status: analysis.status,
        risk_score: analysis.riskScore,
        credits_estimated: analysis.creditsEstimated,
        credits_actual: analysis.creditsActual,
        include_redlines: analysis.includeRedlines,
        started_at: analysis.startedAt?.toISOString() ?? null,
        completed_at: analysis.completedAt?.toISOString() ?? null,
        error: analysis.error ?? null,
        clauses,
      });
    } catch (error) {
      req.log.error({ err: error }, "Get contract analysis error");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── GET /contracts/:id ───────────────────────────── */

router.get(
  "/:id",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const contractId = req.params.id as string;

      const [contract] = await db
        .select()
        .from(schema.contracts)
        .where(
          and(eq(schema.contracts.id, contractId), eq(schema.contracts.userId, userId)),
        )
        .limit(1);

      if (!contract) {
        res.status(404).json({ error: "Contract not found" });
        return;
      }

      res.json({
        id: contract.id,
        filename: contract.originalName,
        file_size: contract.fileSize,
        mime_type: contract.mimeType,
        status: contract.status,
        created_at: contract.createdAt.toISOString(),
      });
    } catch (error) {
      req.log.error({ err: error }, "Get contract error");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── DELETE /contracts/:id ────────────────────────── */
// Deletes a contract and its stored file.
// Blocked when an analysis is queued or processing to prevent deleting a
// file that a running worker still needs. Completed/failed analyses are
// cascade-deleted from the DB via the FK constraint on analyses.contractId.

router.delete(
  "/:id",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.userId!;
      const contractId = req.params.id as string;

      const [contract] = await db
        .select()
        .from(schema.contracts)
        .where(
          and(eq(schema.contracts.id, contractId), eq(schema.contracts.userId, userId))
        )
        .limit(1);

      if (!contract) {
        res.status(404).json({ error: "Contract not found" });
        return;
      }

      // Block deletion while a worker is actively processing this contract.
      const [inFlight] = await db
        .select({ id: schema.analyses.id })
        .from(schema.analyses)
        .where(
          and(
            eq(schema.analyses.contractId, contractId),
            inArray(schema.analyses.status, ["queued", "processing"])
          )
        )
        .limit(1);

      if (inFlight) {
        res.status(409).json({
          error: "Cannot delete a contract while an analysis is in progress.",
          analysis_id: inFlight.id,
        });
        return;
      }

      // Delete from storage first. If this fails the DB row is preserved so
      // the user can retry. An orphaned file is safer than an orphaned DB row
      // (the cleanup scheduler handles unreferenced files; a missing DB row
      // would make the contract unrecoverable).
      const storage = getStorage();
      try {
        await storage.delete(contract.storagePath);
      } catch (err) {
        req.log.error({ contractId, storagePath: contract.storagePath, err }, "contract.file_delete_failed");
        res.status(500).json({ error: "Failed to delete contract file" });
        return;
      }

      // Cascade deletes analyses + clauses via FK.
      await db.delete(schema.contracts).where(eq(schema.contracts.id, contractId));

      req.log.info({ userId, contractId }, "contract.deleted");
      res.status(204).send();
    } catch (error) {
      req.log.error({ err: error }, "Delete contract error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
