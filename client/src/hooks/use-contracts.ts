import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/auth-context";
import * as api from "@/lib/api";
import { mapAnalysisResponse } from "@/lib/mappers/analysis.mapper";

export function useContracts() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: ["contracts"],
    queryFn: api.fetchContracts,
    staleTime: 60_000,
    enabled: isAuthenticated,
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
