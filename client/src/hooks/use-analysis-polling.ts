/**
 * useAnalysisPolling — polls GET /analysis/:id every 3 s.
 * Stops on "completed" or "failed".
 * Tolerates up to 3 consecutive network errors before giving up.
 * On completion, invalidates the plan cache so credit balance refreshes.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { mapJobResult } from "@/lib/mappers/analysis.mapper";
import type { ContractAnalysis } from "@/types/analysis";
import type { AnalyzeContractResult } from "@/lib/api";

export type PollingStatus = "idle" | "polling" | "completed" | "failed";

export interface PollingState {
  status: PollingStatus;
  /** Raw status from the backend on the most recent poll: "queued" | "processing" | "completed" | "failed" */
  backendStatus: "queued" | "processing" | "completed" | "failed" | null;
  analysis: ContractAnalysis | null;
  /** Raw LLM result — available on completion, used for download/suggestions features */
  directResult: AnalyzeContractResult | null;
  error: string | null;
  creditsActual: number | null;
}

const POLL_INTERVAL_MS = 3000;
const MAX_CONSECUTIVE_ERRORS = 3;

export function useAnalysisPolling(analysisId: string | null): PollingState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<PollingState>({
    status: "idle",
    backendStatus: null,
    analysis: null,
    directResult: null,
    error: null,
    creditsActual: null,
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);
  const consecutiveErrorsRef = useRef(0);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stop();
    };
  }, [stop]);

  useEffect(() => {
    if (!analysisId) {
      stop();
      consecutiveErrorsRef.current = 0;
      setState({ status: "idle", backendStatus: null, analysis: null, directResult: null, error: null, creditsActual: null });
      return;
    }

    consecutiveErrorsRef.current = 0;
    setState({ status: "polling", backendStatus: null, analysis: null, directResult: null, error: null, creditsActual: null });

    const poll = async () => {
      try {
        const raw = await api.getAnalysisResult(analysisId);
        if (!isMountedRef.current) return;

        // Successful response — reset error counter
        consecutiveErrorsRef.current = 0;

        if (raw.status === "completed") {
          stop();
          queryClient.invalidateQueries({ queryKey: ["user", "plan"] });
          setState({
            status: "completed",
            backendStatus: "completed",
            analysis: mapJobResult(raw),
            directResult: raw.result,
            error: null,
            creditsActual: raw.credits_actual,
          });
        } else if (raw.status === "failed") {
          stop();
          setState({
            status: "failed",
            backendStatus: "failed",
            analysis: null,
            directResult: null,
            error: raw.error ?? "Analysis failed. Please try again.",
            creditsActual: null,
          });
        } else {
          setState((prev) => ({ ...prev, backendStatus: raw.status }));
        }
      } catch (err: unknown) {
        if (!isMountedRef.current) return;

        consecutiveErrorsRef.current += 1;

        if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS) {
          stop();
          const message = err instanceof Error ? err.message : "Failed to check analysis status.";
          setState({
            status: "failed",
            backendStatus: "failed",
            analysis: null,
            directResult: null,
            error: message,
            creditsActual: null,
          });
        }
        // else: transient error — keep polling
      }
    };

    // Immediate first check, then interval
    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return stop;
  }, [analysisId, queryClient, stop]);

  return state;
}
