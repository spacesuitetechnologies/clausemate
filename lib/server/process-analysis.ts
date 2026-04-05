/**
 * Core analysis processing logic — used by both the QStash worker
 * and the inline fallback in /api/analyze.ts.
 *
 * Required Supabase columns on the `analyses` table:
 *   status         text    DEFAULT 'queued'
 *   full_result    jsonb
 *   error          text
 *   include_redlines boolean DEFAULT false
 *
 * Run this migration if the columns are missing:
 *   ALTER TABLE analyses ADD COLUMN IF NOT EXISTS status text DEFAULT 'completed';
 *   ALTER TABLE analyses ADD COLUMN IF NOT EXISTS full_result jsonb;
 *   ALTER TABLE analyses ADD COLUMN IF NOT EXISTS error text;
 *   ALTER TABLE analyses ADD COLUMN IF NOT EXISTS include_redlines boolean DEFAULT false;
 */

import { getServiceClient } from "./supabase";
import { extractContractText, ExtractionError } from "./extract-text";
import { analyzeWithLLM } from "./llm";
import { mergeWithPolicyRisks } from "./policy";
import type { AnalysisJob, AnalyzeContractResult } from "./types";

export async function processAnalysis(job: AnalysisJob): Promise<void> {
  const { analysis_id, contract_id, user_id, include_redlines } = job;
  const db = getServiceClient();

  // Mark as processing
  await db
    .from("analyses")
    .update({ status: "processing" })
    .eq("id", analysis_id)
    .eq("user_id", user_id);

  let result: AnalyzeContractResult;

  try {
    // Fetch contract metadata
    const { data: contract, error: contractErr } = await db
      .from("contracts")
      .select("file_url, filename")
      .eq("id", contract_id)
      .eq("user_id", user_id)
      .single();

    if (contractErr || !contract) {
      throw new Error("Contract not found");
    }

    // Extract text (with cache)
    const extracted = await extractContractText(contract_id, contract.file_url, contract.filename);

    // LLM analysis
    const llmRaw = await analyzeWithLLM(extracted.trimmedText);
    const llm = mergeWithPolicyRisks(llmRaw);

    result = {
      summary: llm.summary,
      risks: llm.risks,
      clauses: llm.clauses,
      risk_score: llm.risk_score,
      missing_clauses: llm.missing_clauses,
      suggestions: llm.suggestions,
      parties: llm.parties,
      effective_date: llm.effective_date,
      jurisdiction: llm.jurisdiction,
      structured_risks: llm.structured_risks,
      structured_clauses: llm.structured_clauses,
      contract_text: extracted.trimmedText,
      was_trimmed: extracted.wasTrimmed,
    };

    // Persist full result
    await Promise.all([
      db
        .from("analyses")
        .update({
          status: "completed",
          full_result: result as unknown as Record<string, unknown>,
          risk_score: llm.risk_score,
          summary: llm.summary,
          risks: JSON.stringify(llm.risks),
          clauses: JSON.stringify(llm.clauses),
          error: null,
        })
        .eq("id", analysis_id),

      db
        .from("contracts")
        .update({
          latest_analysis_id: analysis_id,
          latest_analysis_status: "completed",
          risk_score: llm.risk_score,
          clause_count: llm.clauses.length,
        })
        .eq("id", contract_id),
    ]);

    console.log(
      `[process] ${analysis_id} completed. risk_score=${llm.risk_score} clauses=${llm.clauses.length}`,
    );
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "An unexpected error occurred during analysis.";

    console.error(`[process] ${analysis_id} failed:`, errorMessage);

    const isUserFacing = err instanceof ExtractionError;
    const publicMessage = isUserFacing
      ? errorMessage
      : "Analysis failed. Please try again.";

    await Promise.all([
      db
        .from("analyses")
        .update({ status: "failed", error: publicMessage })
        .eq("id", analysis_id),

      db
        .from("contracts")
        .update({ latest_analysis_status: "failed" })
        .eq("id", contract_id),
    ]);
  }
}
