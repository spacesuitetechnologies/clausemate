/**
 * useAnalysisPolling — polls GET /analysis/:id every 3 s.
 * Stops on "completed" or "failed".
 * On completion, invalidates the plan cache so credit balance refreshes.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { mapAnalysisResponse } from "@/lib/mappers/analysis.mapper";
import type { ContractAnalysis } from "@/types/analysis";

export type PollingStatus = "idle" | "polling" | "completed" | "failed";

export interface PollingState {
  status: PollingStatus;
  /** Raw status from the backend on the most recent poll: "queued" | "processing" | "completed" | "failed" */
  backendStatus: "queued" | "processing" | "completed" | "failed" | null;
  analysis: ContractAnalysis | null;
  error: string | null;
  creditsActual: number | null;
}

const POLL_INTERVAL_MS = 3000;

export function useAnalysisPolling(analysisId: string | null): PollingState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<PollingState>({
    status: "idle",
    backendStatus: null,
    analysis: null,
    error: null,
    creditsActual: null,
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

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
      setState({ status: "idle", backendStatus: null, analysis: null, error: null, creditsActual: null });
      return;
    }

    setState({ status: "polling", backendStatus: null, analysis: null, error: null, creditsActual: null });

    const poll = async () => {
      try {
        const raw = await api.getAnalysisResult(analysisId);
        if (!isMountedRef.current) return;

        if (raw.status === "completed") {
          stop();
          // Credits were deducted by the worker — refresh the plan balance now
          queryClient.invalidateQueries({ queryKey: ["user", "plan"] });
          setState({
            status: "completed",
            backendStatus: "completed",
            analysis: mapAnalysisResponse(raw),
            error: null,
            creditsActual: raw.credits_actual,
          });
        } else if (raw.status === "failed") {
          stop();
          setState({
            status: "failed",
            backendStatus: "failed",
            analysis: null,
            error: raw.error ?? "Analysis failed. Please try again.",
            creditsActual: null,
          });
        } else {
          // "queued" | "processing" — keep polling, but expose the backend status
          setState((prev) => ({ ...prev, backendStatus: raw.status }));
        }
      } catch (err: unknown) {
        if (!isMountedRef.current) return;
        stop();
        const message =
          err instanceof Error ? err.message : "Failed to check analysis status.";
        setState({
          status: "failed",
          backendStatus: "failed",
          analysis: null,
          error: message,
          creditsActual: null,
        });
      }
    };

    // Immediate first check, then interval
    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return stop;
  }, [analysisId, queryClient, stop]);

  return state;
}
