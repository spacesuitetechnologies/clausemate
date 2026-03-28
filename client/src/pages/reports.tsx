import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import {
  FileText, Search, Clock, AlertTriangle, Download, Loader2,
  RefreshCw, ExternalLink, ShieldAlert, ListChecks, Check,
  Upload, ChevronRight, RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DashboardLayout } from "@/components/DashboardLayout";
import { RiskBar } from "@/components/RiskBar";
import { useContracts, useContractAnalysis, useDirectAnalysis } from "@/hooks/use-contracts";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { getSignedUrlById } from "@/lib/contracts";
import { saveDirectAnalysis } from "@/lib/analyses";
import { useToast } from "@/hooks/use-toast";
import type { ContractSummary } from "@/types/analysis";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function RiskPill({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="text-[12px] text-muted-foreground/50 font-medium">—</span>;
  const color =
    score >= 70 ? "bg-red-50 text-red-600 border-red-200"
    : score >= 40 ? "bg-amber-50 text-amber-600 border-amber-200"
    : "bg-green-50 text-green-600 border-green-200";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold tabular-nums ${color}`}>
      {score}
    </span>
  );
}

function StatusBadge({ status }: { status: ContractSummary["latest_analysis_status"] }) {
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-[10px] font-semibold text-green-700">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        Completed
      </span>
    );
  }
  if (status === "queued" || status === "processing") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[10px] font-semibold text-amber-700">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        {status === "queued" ? "Queued" : "Processing"}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-[10px] font-semibold text-red-700">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted border border-border text-[10px] font-semibold text-muted-foreground">
      Uploaded
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

function ReportsContent() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [reanalyzingId, setReanalyzingId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

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
      queryClient.invalidateQueries({ queryKey: ["contract-analysis", selectedId] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not retry analysis.";
      toast({ title: "Retry failed", description: msg, variant: "destructive" });
    } finally {
      setRetrying(false);
    }
  }, [selectedId, analysis, queryClient, toast]);

  const handleReanalyze = useCallback(async (contractId: string) => {
    setReanalyzingId(contractId);
    try {
      const result = await api.analyzeContract(contractId);
      await saveDirectAnalysis(contractId, result);
      queryClient.invalidateQueries({ queryKey: ["direct-analysis", contractId] });
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      toast({ title: "Re-analysis complete", description: "The contract has been re-analyzed." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Re-analysis failed.";
      toast({ title: "Re-analysis failed", description: msg, variant: "destructive" });
    } finally {
      setReanalyzingId(null);
    }
  }, [queryClient, toast]);

  // Sort latest first, then filter by search
  const sorted = [...contracts].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const filtered = sorted.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()),
  );
  const selected = contracts.find((c) => c.id === selectedId);

  return (
    <div className="max-w-[1100px] space-y-6">
      {/* ── Page header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold mb-0.5">Reports</h1>
          <p className="text-sm text-muted-foreground">
            {contracts.length > 0
              ? `${contracts.length} contract${contracts.length === 1 ? "" : "s"} analyzed`
              : "View and manage your analyzed contracts"}
          </p>
        </div>
        <Button size="sm" className="gap-2 hidden sm:flex" onClick={() => setLocation("/upload")}>
          <Upload className="h-3.5 w-3.5" /> New Analysis
        </Button>
      </div>

      {/* ── Search ── */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search contracts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10 h-9 text-[13px]"
          data-testid="search-contracts-input"
        />
      </div>

      {/* ── Body ── */}
      {contractsLoading ? (
        <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-[13px]">Loading reports…</span>
        </div>
      ) : contracts.length === 0 ? (
        /* ── Empty state ── */
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-dashed border-border bg-white py-20 flex flex-col items-center gap-4"
        >
          <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
            <FileText className="h-7 w-7 text-primary/50" />
          </div>
          <div className="text-center">
            <p className="text-[15px] font-semibold mb-1">No reports yet</p>
            <p className="text-[13px] text-muted-foreground">Upload a contract to begin.</p>
          </div>
          <Button size="sm" className="gap-2 mt-1" onClick={() => setLocation("/upload")}>
            <Upload className="h-3.5 w-3.5" /> Upload a Contract
          </Button>
        </motion.div>
      ) : (
        <div className="grid lg:grid-cols-5 gap-5">
          {/* ── Contract list ── */}
          <div className="lg:col-span-2 space-y-2">
            {filtered.length === 0 ? (
              <div className="rounded-xl border border-border bg-white p-6 text-center">
                <p className="text-[13px] font-medium mb-0.5">No matches</p>
                <p className="text-[12px] text-muted-foreground">Try a different search term.</p>
              </div>
            ) : (
              filtered.map((c, i) => (
                <motion.div
                  key={c.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  onClick={() => setSelectedId(c.id)}
                  className={`group rounded-xl border p-4 cursor-pointer transition-all duration-200 ${
                    selectedId === c.id
                      ? "border-primary bg-primary/[0.03] shadow-sm ring-1 ring-primary/10"
                      : "border-border bg-white hover:border-primary/40 hover:shadow-md hover:-translate-y-px"
                  }`}
                  data-testid={`report-card-${c.id}`}
                >
                  <div className="flex items-start gap-3">
                    {/* Icon */}
                    <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 border ${
                      selectedId === c.id ? "bg-primary/8 border-primary/20" : "bg-muted/60 border-border"
                    }`}>
                      <FileText className={`h-4 w-4 ${selectedId === c.id ? "text-primary" : "text-muted-foreground"}`} />
                    </div>

                    {/* Text */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold truncate leading-tight">{c.name}</p>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <StatusBadge status={c.latest_analysis_status} />
                        <span className="text-muted-foreground/40 text-[10px]">·</span>
                        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <Clock className="h-2.5 w-2.5" />
                          {formatDate(c.created_at)}
                        </span>
                      </div>
                    </div>

                    {/* Risk score */}
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <RiskPill score={c.risk_score} />
                      <ChevronRight className={`h-3.5 w-3.5 transition-opacity ${selectedId === c.id ? "opacity-60 text-primary" : "opacity-0 group-hover:opacity-40"}`} />
                    </div>
                  </div>
                </motion.div>
              ))
            )}
          </div>

          {/* ── Detail panel ── */}
          <div className="lg:col-span-3">
            <AnimatePresence mode="wait">
              {selected ? (
                <motion.div
                  key={selected.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="rounded-xl border border-border bg-white overflow-hidden"
                >
                  {/* Detail header */}
                  <div className="px-6 py-5 border-b border-border/50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-[15px] font-semibold truncate">{selected.name}</h3>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <StatusBadge status={selected.latest_analysis_status} />
                          <span className="text-[11px] text-muted-foreground">
                            {formatDate(selected.created_at)}
                          </span>
                          {(selected.clause_count ?? 0) > 0 && (
                            <>
                              <span className="text-muted-foreground/40">·</span>
                              <span className="text-[11px] text-muted-foreground">
                                {selected.clause_count} clause{selected.clause_count === 1 ? "" : "s"}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 h-8 text-[12px]"
                          onClick={() => handleReanalyze(selected.id)}
                          disabled={reanalyzingId === selected.id}
                          data-testid="reanalyze-btn"
                        >
                          {reanalyzingId === selected.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <RotateCcw className="h-3.5 w-3.5" />}
                          {reanalyzingId === selected.id ? "Analyzing…" : "Re-analyze"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 h-8 text-[12px]"
                          onClick={() => handleView(selected.id)}
                          disabled={viewingId === selected.id}
                          data-testid="view-file-btn"
                        >
                          {viewingId === selected.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <ExternalLink className="h-3.5 w-3.5" />}
                          {viewingId === selected.id ? "Opening…" : "View"}
                        </Button>
                        <Button variant="outline" size="sm" className="gap-1.5 h-8 text-[12px]" data-testid="export-btn">
                          <Download className="h-3.5 w-3.5" /> Export
                        </Button>
                      </div>
                    </div>

                    {/* Risk bar — only when a score exists */}
                    {(analysis?.overall_score ?? selected.risk_score) != null && (
                      <div className="mt-4">
                        <RiskBar score={analysis?.overall_score ?? selected.risk_score ?? 0} />
                      </div>
                    )}
                  </div>

                  {/* Analysis body */}
                  <div className="p-5 space-y-3">
                    {(analysisLoading || directAnalysisLoading || reanalyzingId === selected.id) ? (
                      <div className="py-10 flex flex-col items-center gap-3 text-muted-foreground">
                        <Loader2 className="h-6 w-6 animate-spin" />
                        <span className="text-[12px]">
                          {reanalyzingId === selected.id ? "Re-analyzing contract…" : "Loading analysis…"}
                        </span>
                      </div>

                    ) : directAnalysis ? (
                      <>
                        {/* Summary */}
                        <div className="rounded-lg bg-primary/[0.03] border border-primary/10 p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-widest text-primary/50 mb-2">Summary</p>
                          <p className="text-[13px] text-foreground/80 leading-relaxed">{directAnalysis.summary}</p>
                        </div>

                        {/* Risks */}
                        {directAnalysis.risks.length > 0 && (
                          <div className="rounded-lg border border-border/60 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                            <div className="flex items-center gap-2 mb-3">
                              <ShieldAlert className="h-4 w-4 text-red-400" />
                              <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground/50">Identified Risks</p>
                              <span className="ml-auto text-[10px] font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded-full border border-red-100">
                                {directAnalysis.risks.length}
                              </span>
                            </div>
                            <div className="space-y-2">
                              {directAnalysis.risks.map((risk, i) => {
                                const isHigh = /\b(high|critical|severe|terminat|penalt|liabilit)\b/i.test(risk);
                                return (
                                  <div key={i} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${
                                    isHigh
                                      ? "bg-red-50/60 border-red-200/70"
                                      : "bg-amber-50/50 border-amber-200/60"
                                  }`}>
                                    <AlertTriangle className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${isHigh ? "text-red-500" : "text-amber-500"}`} />
                                    <span className="text-[12px] text-foreground/80 leading-relaxed">{risk}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Clauses */}
                        {directAnalysis.clauses.length > 0 && (
                          <div className="rounded-lg border border-border/60 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                            <div className="flex items-center gap-2 mb-3">
                              <ListChecks className="h-4 w-4 text-primary/60" />
                              <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground/50">Key Clauses</p>
                              <span className="ml-auto text-[10px] font-semibold text-primary/70 bg-primary/8 px-1.5 py-0.5 rounded-full border border-primary/15">
                                {directAnalysis.clauses.length}
                              </span>
                            </div>
                            <div className="space-y-1.5">
                              {directAnalysis.clauses.map((clause, i) => (
                                <div key={i} className="flex items-center gap-2.5 rounded-md bg-muted/30 border border-border/40 px-3 py-2 transition-colors duration-150 hover:bg-muted/50">
                                  <div className="h-4 w-4 rounded-full bg-green-50 border border-green-200 flex items-center justify-center shrink-0">
                                    <Check className="h-2.5 w-2.5 text-green-600" />
                                  </div>
                                  <span className="text-[12px] text-foreground/75">{clause}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>

                    ) : analysis?.status === "queued" ? (
                      <div className="py-10 flex flex-col items-center gap-3 text-center">
                        <div className="h-10 w-10 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center">
                          <Clock className="h-5 w-5 text-amber-500" />
                        </div>
                        <div>
                          <p className="text-[13px] font-semibold">Queued</p>
                          <p className="text-[12px] text-muted-foreground mt-0.5">Waiting for a worker to start…</p>
                        </div>
                      </div>

                    ) : analysis?.status === "processing" ? (
                      <div className="py-10 flex flex-col items-center gap-3 text-center">
                        <Loader2 className="h-10 w-10 text-primary animate-spin" />
                        <div>
                          <p className="text-[13px] font-semibold">Processing</p>
                          <p className="text-[12px] text-muted-foreground mt-0.5">AI is analyzing your contract…</p>
                        </div>
                      </div>

                    ) : analysis?.status === "failed" ? (
                      <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3">
                        <div className="flex items-start gap-2.5">
                          <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-semibold text-red-700">Analysis failed</p>
                            <p className="text-[12px] text-red-600/80 leading-relaxed mt-0.5">
                              {analysis.error ?? "An unexpected error occurred."}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full h-8 text-[12px] border-red-200 text-red-600 hover:bg-red-100"
                          onClick={handleRetry}
                          disabled={retrying}
                          data-testid="retry-analysis-btn"
                        >
                          {retrying
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                            : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
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
                              cl.risk_level === "HIGH" ? "risk-high-bg"
                              : cl.risk_level === "MEDIUM" ? "risk-medium-bg"
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
                      <div className="py-10 text-center">
                        <p className="text-[13px] text-muted-foreground">No analysis available for this contract.</p>
                      </div>
                    )}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="rounded-xl border border-dashed border-border bg-white h-full min-h-[300px] flex flex-col items-center justify-center gap-3 p-12 text-center"
                >
                  <ChevronRight className="h-8 w-8 text-muted-foreground/20 rotate-180" />
                  <div>
                    <p className="text-[13px] font-medium text-muted-foreground">Select a report</p>
                    <p className="text-[12px] text-muted-foreground/60 mt-0.5">Click any contract to view its analysis</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
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
