import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/auth-context";
import * as api from "@/lib/api";
import { fetchUserContracts } from "@/lib/contracts";
import { fetchDirectAnalysis } from "@/lib/analyses";
import { mapAnalysisResponse } from "@/lib/mappers/analysis.mapper";

export function useContracts() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: ["contracts"],
    // Mock mode → existing in-memory mock; real mode → Supabase
    queryFn: api.USE_MOCK ? api.fetchContracts : fetchUserContracts,
    staleTime: 60_000,
    enabled: isAuthenticated,
  });
}

export function useDirectAnalysis(contractId: string | null) {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: ["direct-analysis", contractId],
    queryFn: async () => {
      if (api.USE_MOCK) {
        // Return mock data in development so the Reports page is populated
        return {
          id: `mock-direct-${contractId}`,
          contract_id: contractId!,
          summary: "This is a sample contract summary.",
          risks: ["Payment delay risk", "Termination clause unclear"],
          clauses: ["Payment terms", "Liability clause"],
          created_at: new Date().toISOString(),
        };
      }
      return fetchDirectAnalysis(contractId!);
    },
    enabled: isAuthenticated && !!contractId,
    staleTime: 5 * 60_000,
  });
}

export function useContractAnalysis(contractId: string | null) {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: ["contract-analysis", contractId],
    queryFn: async () => {
      const raw = await api.fetchContractAnalysis(contractId!);
      return raw ? mapAnalysisResponse(raw) : null;
    },
    enabled: isAuthenticated && !!contractId,
    staleTime: 5 * 60_000,
    // Poll every 3 s while the analysis is still in-flight; stop once terminal.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "processing" ? 3000 : false;
    },
  });
}
