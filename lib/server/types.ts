export interface StructuredRisk {
  level: "low" | "medium" | "high";
  reason: string;
  clause?: string;
  issue?: string;
  impact?: string;
}

export interface StructuredClauses {
  termination: string | null;
  payment: string | null;
  liability: string | null;
  [key: string]: string | null;
}

export interface MissingClause {
  clause: string;
  importance: string;
  risk: string;
}

export interface Suggestion {
  clause: string;
  fix: string;
}

export interface LLMResult {
  summary: string;
  risk_score: number;
  risks: string[];
  clauses: string[];
  parties: string[];
  effective_date: string | null;
  jurisdiction: string | null;
  structured_risks: StructuredRisk[];
  structured_clauses: StructuredClauses;
  missing_clauses: MissingClause[];
  suggestions: Suggestion[];
}

/** Shape stored in analyses.full_result and returned by GET /api/analysis/[id] */
export interface AnalyzeContractResult {
  summary: string | null;
  risks: string[];
  clauses: string[];
  risk_score: number | null;
  missing_clauses: MissingClause[];
  suggestions: Suggestion[];
  parties: string[];
  effective_date: string | null;
  jurisdiction: string | null;
  structured_risks: StructuredRisk[];
  structured_clauses: StructuredClauses;
  contract_text: string;
  was_trimmed: boolean;
}

export interface AnalysisJob {
  analysis_id: string;
  contract_id: string;
  user_id: string;
  include_redlines: boolean;
  /** Number of times this job has already been attempted (0-indexed). Used for logging. */
  retry_count?: number;
}

/** Token usage and estimated cost from one LLM call */
export interface LLMUsage {
  provider: string;
  input_tokens: number;
  output_tokens: number;
  /** Estimated USD cost based on published pricing */
  cost_usd: number;
}
