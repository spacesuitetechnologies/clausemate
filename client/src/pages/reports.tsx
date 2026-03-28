import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import { FileText, Search, Clock, AlertTriangle, Download, Filter, Loader2, RefreshCw, ExternalLink, ShieldAlert, ListChecks, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DashboardLayout } from "@/components/DashboardLayout";
import { RiskBar } from "@/components/RiskBar";
import { useContracts, useContractAnalysis, useDirectAnalysis } from "@/hooks/use-contracts";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { getSignedUrlById } from "@/lib/contracts";
import { useToast } from "@/hooks/use-toast";

function ReportsContent() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleView = useCallback(async (contractId: string) => {
    setViewingId(contractId);
    try {
      const url = await getSignedUrlById(contractId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not open file.";
      toast({ title: "Could not open file", description: msg, variant: "destructive" });
    } finally {
      setViewingId(null);
    }
  }, [toast]);

  const { data: contracts = [], isLoading: contractsLoading } = useContracts();
  const { data: analysis, isLoading: analysisLoading } = useContractAnalysis(selectedId);
  const { data: directAnalysis, isLoading: directAnalysisLoading } = useDirectAnalysis(selectedId);

  const handleRetry = useCallback(async () => {
    if (!selectedId || !analysis) return;
    setRetrying(true);
    try {
      await api.startAnalysis(selectedId, analysis.include_redlines, 6);
      // Invalidate so the hook re-fetches the new queued analysis (and starts auto-polling)
      queryClient.invalidateQueries({ queryKey: ["contract-analysis", selectedId] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not retry analysis.";
      toast({ title: "Retry failed", description: msg, variant: "destructive" });
    } finally {
      setRetrying(false);
    }
  }, [selectedId, analysis, queryClient, toast]);

  const filtered = contracts.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()),
  );
  const selected = contracts.find((c) => c.id === selectedId);

  return (
    <div className="max-w-[960px] space-y-6">
      <div>
        <h1 className="text-xl font-semibold mb-1">Reports</h1>
        <p className="text-sm text-muted-foreground">
          View and manage all your analyzed contracts.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search contracts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 h-10 text-[13px]"
            data-testid="search-contracts-input"
          />
        </div>
        <Button variant="outline" size="sm" className="gap-2" data-testid="filter-btn">
          <Filter className="h-4 w-4" /> Filter
        </Button>
      </div>

      <div className="grid lg:grid-cols-5 gap-5">
        {/* Contract list */}
        <div className="lg:col-span-2 space-y-2">
          {contractsLoading ? (
            <div className="rounded-xl border border-border bg-white p-4 text-center">
              <p className="text-[12px] text-muted-foreground">Loading contracts...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-border bg-white p-4 text-center">
              <p className="text-[12px] text-muted-foreground">No contracts found.</p>
            </div>
          ) : (
            filtered.map((c, i) => (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                onClick={() => setSelectedId(c.id)}
                className={`rounded-xl border p-4 cursor-pointer transition-all duration-150 ${
                  selectedId === c.id
                    ? "border-primary bg-primary/[0.02]"
                    : "border-border bg-white hover:border-primary/20"
                }`}
                data-testid={`report-card-${c.id}`}
              >
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-card flex items-center justify-center border border-border">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium truncate">{c.name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Clock className="h-3 w-3 text-muted-foreground" />
                      <span className="text-[11px] text-muted-foreground">
                        {c.created_at?.slice(0, 10) ?? ""}
                      </span>
                      {(c.latest_analysis_status === "queued" || c.latest_analysis_status === "processing") && (
                        <span className="flex items-center gap-0.5 text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          {c.latest_analysis_status === "queued" ? "Queued" : "Processing"}
                        </span>
                      )}
                      {c.latest_analysis_status === "failed" && (
                        <span className="text-[10px] font-medium text-red-600 bg-red-50 px-1.5 py-0.5 rounded-full">
                          Failed
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className={`text-sm font-semibold ${
                      (c.risk_score ?? 0) >= 70
                        ? "text-red-500"
                        : (c.risk_score ?? 0) >= 40
                          ? "text-amber-500"
                          : "text-green-500"
                    }`}
                  >
                    {c.risk_score ?? "—"}
                  </span>
                </div>
              </motion.div>
            ))
          )}
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-3">
          {selected ? (
            <motion.div
              key={selected.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-border bg-white p-6 space-y-5"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-semibold">{selected.name}</h3>
                  <p className="text-[12px] text-muted-foreground mt-0.5">
                    Analyzed on {selected.created_at?.slice(0, 10) ?? ""} ·{" "}
                    {selected.clause_count ?? 0} clauses
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => handleView(selected.id)}
                    disabled={viewingId === selected.id}
                    data-testid="view-file-btn"
                  >
                    {viewingId === selected.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ExternalLink className="h-3.5 w-3.5" />
                    )}
                    {viewingId === selected.id ? "Opening…" : "View"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    data-testid="export-btn"
                  >
                    <Download className="h-3.5 w-3.5" /> Export
                  </Button>
                </div>
              </div>

              <div className="px-2">
                <RiskBar score={analysis?.overall_score ?? selected.risk_score ?? 0} />
              </div>

              <div className="space-y-3">
                {(analysisLoading || directAnalysisLoading) ? (
                  <div className="py-6 flex items-center justify-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-[12px]">Loading analysis…</span>
                  </div>
                ) : directAnalysis ? (
                  // ── Direct analysis (saved via /api/analyze) ──────────────
                  <>
                    {/* Summary */}
                    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Summary</p>
                      <p className="text-[12px] text-foreground/80 leading-relaxed">{directAnalysis.summary}</p>
                    </div>

                    {/* Risks */}
                    {directAnalysis.risks.length > 0 && (
                      <div className="rounded-lg border border-border/60 bg-white p-3">
                        <div className="flex items-center gap-1.5 mb-2">
                          <ShieldAlert className="h-3.5 w-3.5 text-red-500" />
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Risks</p>
                        </div>
                        <ul className="space-y-1.5">
                          {directAnalysis.risks.map((risk, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full bg-red-100 flex items-center justify-center text-[8px] font-bold text-red-600">!</span>
                              <span className="text-[12px] text-muted-foreground">{risk}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Clauses */}
                    {directAnalysis.clauses.length > 0 && (
                      <div className="rounded-lg border border-border/60 bg-white p-3">
                        <div className="flex items-center gap-1.5 mb-2">
                          <ListChecks className="h-3.5 w-3.5 text-primary/70" />
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Key Clauses</p>
                        </div>
                        <ul className="space-y-1.5">
                          {directAnalysis.clauses.map((clause, i) => (
                            <li key={i} className="flex items-center gap-2">
                              <Check className="h-3 w-3 text-green-500 shrink-0" />
                              <span className="text-[12px] text-muted-foreground">{clause}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : analysis?.status === "queued" ? (
                  <div className="py-6 flex flex-col items-center gap-2 text-center">
                    <div className="h-8 w-8 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center">
                      <Clock className="h-4 w-4 text-amber-500" />
                    </div>
                    <p className="text-[12px] font-medium">Queued</p>
                    <p className="text-[11px] text-muted-foreground">Waiting for a worker to start…</p>
                  </div>
                ) : analysis?.status === "processing" ? (
                  <div className="py-6 flex flex-col items-center gap-2 text-center">
                    <Loader2 className="h-8 w-8 text-primary animate-spin" />
                    <p className="text-[12px] font-medium">Processing</p>
                    <p className="text-[11px] text-muted-foreground">AI is analyzing your contract…</p>
                  </div>
                ) : analysis?.status === "failed" ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium text-red-700">Analysis failed</p>
                        <p className="text-[11px] text-red-600 leading-relaxed mt-0.5">
                          {analysis.error ?? "An unexpected error occurred."}
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-[11px] border-red-200 text-red-600 hover:bg-red-100"
                      onClick={handleRetry}
                      disabled={retrying}
                      data-testid="retry-analysis-btn"
                    >
                      {retrying ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <RefreshCw className="h-3 w-3 mr-1" />
                      )}
                      {retrying ? "Retrying…" : "Retry Analysis"}
                    </Button>
                  </div>
                ) : analysis?.clauses && analysis.clauses.length > 0 ? (
                  analysis.clauses.slice(0, 4).map((cl) => {
                    const riskClass = cl.risk_level.toLowerCase();
                    return (
                      <div
                        key={cl.id}
                        className={`rounded-lg p-3 border ${
                          cl.risk_level === "HIGH"
                            ? "risk-high-bg"
                            : cl.risk_level === "MEDIUM"
                              ? "risk-medium-bg"
                              : "risk-low-bg"
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <AlertTriangle className={`h-3 w-3 risk-${riskClass}`} />
                          <span className="text-[12px] font-medium">{cl.title}</span>
                          <span className={`ml-auto text-[10px] font-semibold uppercase risk-${riskClass}`}>
                            {cl.risk_level}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
                          {cl.explanation}
                        </p>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-[12px] text-muted-foreground py-4 text-center">
                    No analysis available for this contract.
                  </p>
                )}
              </div>
            </motion.div>
          ) : (
            <div className="rounded-xl border border-border bg-white p-12 text-center">
              <FileText className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-[13px] text-muted-foreground">
                Select a contract to view its report
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <DashboardLayout>
      <ReportsContent />
    </DashboardLayout>
  );
}
