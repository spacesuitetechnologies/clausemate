/**
 * API Service Layer — Mock → Real Switch
 *
 * USE_MOCK = true  → in-memory mock (no backend required)
 * USE_MOCK = false → real API calls with JWT auth via Bearer token
 *
 * Controlled by VITE_USE_MOCK env var:
 *   VITE_USE_MOCK=true   → mock mode (development only)
 *   VITE_USE_MOCK=false  → real API (production)
 *
 * vite.config.ts enforces that VITE_USE_MOCK=true is rejected at build time.
 * When false/unset, import.meta.env.VITE_USE_MOCK is undefined at build time
 * so Rollup dead-code-eliminates all if (USE_MOCK) branches, including the
 * dynamic import("./mock-data") calls — mock data never enters the bundle.
 */

import type { UserPlan, CreditUsage, AnalysisCost, PlanId } from "./credits";
import { CREDIT_COSTS, getPlan } from "./credits";
import type { AnalysisResponse, ContractSummary } from "@/types/analysis";

export const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";
const BASE_URL = "/api";

// ── Central Error Handler ─────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.ok) {
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  let data: Record<string, unknown> | undefined;
  try {
    const body = await res.json();
    message = body.error ?? body.message ?? message;
    code = body.code;
    data = body;
  } catch {}

  throw new ApiError(message, res.status, code, data);
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

function delay(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let mockPlan: UserPlan = {
  plan_id: "free",
  plan_name: "Free",
  credits_total: 10,
  credits_used: 0,
  credits_remaining: 10,
  overage_credits: 0,
  overage_cost: 0,
  can_redline: false,
  can_rewrite: false,
};

export function resetMockState(planId: PlanId = "free"): void {
  const plan = getPlan(planId);
  mockPlan = {
    plan_id: planId,
    plan_name: plan.name,
    credits_total: plan.credits,
    credits_used: 0,
    credits_remaining: plan.credits,
    overage_credits: 0,
    overage_cost: 0,
    can_redline: planId !== "free",
    can_rewrite: planId === "professional" || planId === "enterprise",
  };
}

// ── User Plan / Credits ───────────────────────────────────────────────────────

export async function fetchUserPlan(): Promise<UserPlan> {
  if (USE_MOCK) {
    await delay(150);
    return { ...mockPlan };
  }
  const res = await fetch(`${BASE_URL}/user/plan`, { credentials: "include" });
  return handleResponse(res);
}

export async function fetchUsage(): Promise<CreditUsage> {
  if (USE_MOCK) {
    await delay(100);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return {
      credits_used: mockPlan.credits_used,
      credits_remaining: mockPlan.credits_remaining,
      credits_total: mockPlan.credits_total,
      overage_credits: mockPlan.overage_credits,
      overage_cost: mockPlan.overage_cost,
      period_start: start.toISOString().slice(0, 10),
      period_end: end.toISOString().slice(0, 10),
    };
  }
  const res = await fetch(`${BASE_URL}/user/usage`, { credentials: "include" });
  return handleResponse(res);
}

// ── Billing / Razorpay ───────────────────────────────────────────────────────
// upgradePlan via direct POST /user/plan has been removed.
// Plan upgrades go through Razorpay: createSubscription → checkout → webhook.

export interface CreateSubscriptionResult {
  subscription_id: string;
  key_id: string;
  plan_id: string;
  plan_name: string;
  monthly_price: number;
}

export async function createSubscription(
  planId: "starter" | "professional" | "enterprise",
): Promise<CreateSubscriptionResult> {
  if (USE_MOCK) {
    await delay(400);
    const plan = getPlan(planId as PlanId);
    return {
      subscription_id: `mock-sub-${planId}-${Date.now()}`,
      key_id: "rzp_test_mock",
      plan_id: planId,
      plan_name: plan.name,
      monthly_price: plan.monthly_price,
    };
  }
  const res = await fetch(`${BASE_URL}/billing/create-subscription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ plan_id: planId }),
  });
  return handleResponse(res);
}

export interface VerifyPaymentParams {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}

export async function verifyPayment(
  params: VerifyPaymentParams,
): Promise<{ verified: boolean; status: string }> {
  if (USE_MOCK) {
    await delay(300);
    return { verified: true, status: "active" };
  }
  const res = await fetch(`${BASE_URL}/billing/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(params),
  });
  return handleResponse(res);
}

// ── Contracts ─────────────────────────────────────────────────────────────────

export async function fetchContracts(): Promise<ContractSummary[]> {
  if (USE_MOCK) {
    await delay(200);
    const { mockContracts } = await import("./mock-data");
    return mockContracts.map((c) => ({
      id: c.id,
      name: c.name,
      file_size: 0,
      status: c.status,
      created_at: c.date,
      risk_score: c.riskScore,
      high_risk_count: c.highRisk,
      clause_count: c.clauses,
      latest_analysis_id: `mock-analysis-${c.id}`,
    }));
  }
  const res = await fetch(`${BASE_URL}/contracts`, { credentials: "include" });
  return handleResponse(res);
}

export async function uploadContract(
  formData: FormData,
  onProgress?: (pct: number) => void,
): Promise<{ contract_id: string; filename: string; file_size: number; status: string }> {
  if (USE_MOCK) {
    for (let p = 0; p <= 100; p += 25) {
      await delay(120);
      onProgress?.(p);
    }
    return {
      contract_id: "mock-contract-id",
      filename: "contract.pdf",
      file_size: 250000,
      status: "uploaded",
    };
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).error ?? msg;
        } catch {}
        reject(new ApiError(msg, xhr.status));
      }
    });
    xhr.addEventListener("error", () =>
      reject(new ApiError("Network error during upload", 0)),
    );
    xhr.open("POST", `${BASE_URL}/contracts/upload`);
    xhr.withCredentials = true;
    xhr.send(formData);
  });
}

// ── Analysis ──────────────────────────────────────────────────────────────────

export interface StartAnalysisResult {
  analysis_id: string;
  status: string;
  estimated_credits: number;
  actual_credits: number;
  breakdown: AnalysisCost["breakdown"];
}

export async function startAnalysis(
  contractId: string,
  includeRedlines = false,
  clauseCount = 6,
): Promise<StartAnalysisResult> {
  if (USE_MOCK) {
    await delay(500);
    const analysisCost = CREDIT_COSTS.ANALYSIS_DEFAULT;
    let total = analysisCost;
    const breakdown: AnalysisCost["breakdown"] = [
      { action: "analysis", label: "Contract analysis", credits: analysisCost },
    ];
    if (includeRedlines && mockPlan.can_redline) {
      const redlineCost = clauseCount * CREDIT_COSTS.REDLINE;
      breakdown.push({
        action: "redline",
        label: `Redline suggestions (${clauseCount} clauses)`,
        credits: redlineCost,
      });
      total += redlineCost;
    }
    // Apply mock deduction
    mockPlan.credits_used += total;
    mockPlan.credits_remaining = Math.max(0, mockPlan.credits_remaining - total);
    if (mockPlan.credits_remaining === 0 && mockPlan.plan_id !== "free") {
      const overage = mockPlan.credits_used - mockPlan.credits_total;
      if (overage > 0) {
        mockPlan.overage_credits = overage;
        const plan = getPlan(mockPlan.plan_id);
        mockPlan.overage_cost = overage * plan.overage_rate;
      }
    }
    return {
      analysis_id: "mock-analysis-id",
      status: "queued",
      estimated_credits: total,
      actual_credits: 0,
      breakdown,
    };
  }

  const res = await fetch(`${BASE_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ file_id: contractId, include_redlines: includeRedlines }),
  });
  if (res.status === 402) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? "Insufficient credits", 402);
  }
  return handleResponse(res);
}

// ── Direct analysis (mock server endpoint) ────────────────────────────────────

export interface AnalyzeContractResult {
  summary: string;
  risks: string[];
  clauses: string[];
}

export async function analyzeContract(
  contractId: string,
): Promise<AnalyzeContractResult> {
  if (USE_MOCK) {
    await delay(800);
    return {
      summary: "This is a sample contract summary.",
      risks: ["Payment delay risk", "Termination clause unclear"],
      clauses: ["Payment terms", "Liability clause"],
    };
  }
  const res = await fetch(`${BASE_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ contract_id: contractId }),
  });
  return handleResponse(res);
}

export async function getAnalysisResult(analysisId: string): Promise<AnalysisResponse> {
  if (USE_MOCK) {
    // Simulate a short processing delay then return completed
    await delay(300);
    const { mockClauses } = await import("./mock-data");
    return {
      id: analysisId,
      contract_id: "mock-contract-id",
      contract_name: "service_agreement_2026.pdf",
      status: "completed",
      risk_score: 72,
      credits_estimated: 10,
      credits_actual: 10,
      include_redlines: false,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      error: null,
      clauses: mockClauses.map((c, i) => ({
        id: c.id,
        clause_number: i + 1,
        type: "general",
        title: c.title,
        text: c.text,
        risk_level: c.riskLevel,
        score: c.riskLevel === "high" ? 75 : c.riskLevel === "medium" ? 50 : 20,
        explanation: c.explanation,
        suggested_rewrite: c.suggestedRewrite,
        policy_violations: null,
        issues: [],
      })),
    };
  }
  const res = await fetch(`${BASE_URL}/analysis/${analysisId}`, {
    credentials: "include",
  });
  return handleResponse(res);
}

/**
 * Fetch the latest analysis for a given contract.
 * Requires backend: GET /api/contracts/:id/analysis
 */
export async function fetchContractAnalysis(
  contractId: string,
): Promise<AnalysisResponse | null> {
  if (USE_MOCK) {
    return getAnalysisResult(`mock-analysis-${contractId}`);
  }
  const res = await fetch(`${BASE_URL}/contracts/${contractId}/analysis`, {
    credentials: "include",
  });
  if (res.status === 404) return null;
  return handleResponse(res);
}
