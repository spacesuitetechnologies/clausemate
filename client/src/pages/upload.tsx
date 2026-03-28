import { useState, useCallback, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import {
  Upload,
  FileText,
  X,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Lock,
  Coins,
  RefreshCw,
  Clock,
  Loader2,
  FileWarning,
  ShieldAlert,
  ListChecks,
  BarChart3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardLayout } from "@/components/DashboardLayout";
import { RiskBar } from "@/components/RiskBar";
import { UpgradeBanner } from "@/components/UpgradeBanner";
import { useAuth } from "@/context/auth-context";
import { useCredits } from "@/hooks/use-credits";
import { useAnalysisPolling } from "@/hooks/use-analysis-polling";
import { useToast } from "@/hooks/use-toast";
import * as api from "@/lib/api";
import { handleUpload } from "@/lib/upload";
import { saveDirectAnalysis } from "@/lib/analyses";
import type { AnalysisCost } from "@/lib/credits";
import type { ClauseResult } from "@/types/analysis";
import type { AnalyzeContractResult } from "@/lib/api";

// Three concrete steps shown in the progress panel
const ANALYSIS_STEPS = ["Uploading contract", "Processing document", "Generating results"];

// ── File validation ────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024;

function validateFile(f: File): string | null {
  if (f.size === 0) {
    return "File is empty. Please upload a valid contract document.";
  }
  if (f.type !== "application/pdf") {
    return "Only PDF files are supported.";
  }
  if (f.size > MAX_FILE_SIZE) {
    return `File too large. Max size is 10 MB (got ${(f.size / 1024 / 1024).toFixed(1)} MB).`;
  }
  return null;
}

function cleanErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return "Analysis failed. Please try again.";
  const msg = err.message;
  // Strip raw HTTP noise and return a clean user-facing string
  if (msg.includes("402") || msg.toLowerCase().includes("insufficient")) return "Insufficient credits to run this analysis.";
  if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) return "Your session expired. Please sign in again.";
  if (msg.includes("413") || msg.toLowerCase().includes("too large")) return "File is too large to process.";
  if (msg.includes("fetch") || msg.includes("Failed to fetch") || msg.includes("NetworkError")) return "Could not reach the server. Check your connection.";
  if (msg.includes("500") || msg.includes("Internal Server Error")) return "Server error. Please try again in a moment.";
  // If the message looks clean (no HTTP codes), pass it through
  if (/^\d{3}/.test(msg)) return "Analysis failed. Please try again.";
  return msg;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

// ── Contract viewer (right panel) ─────────────────────────────────────────────

function ContractViewer({
  previewUrl,
  filename,
}: {
  previewUrl: string | null;
  filename: string | null;
}) {
  if (!previewUrl || !filename) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 select-none">
        <div className="h-16 w-16 rounded-2xl bg-muted/60 flex items-center justify-center">
          <FileText className="h-8 w-8 text-muted-foreground/30" />
        </div>
        <div className="text-center">
          <p className="text-[13px] font-medium text-muted-foreground">No contract loaded</p>
          <p className="text-[12px] text-muted-foreground/60 mt-1">
            Upload a contract to preview it here
          </p>
        </div>
      </div>
    );
  }

  const ext = fileExt(filename);
  const canPreview = ext === "pdf" || ext === "txt";

  if (!canPreview) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 select-none px-8 text-center">
        <div className="h-16 w-16 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center">
          <FileWarning className="h-8 w-8 text-amber-400" />
        </div>
        <div>
          <p className="text-[13px] font-medium">{filename}</p>
          <p className="text-[12px] text-muted-foreground mt-1.5">
            .{ext.toUpperCase()} files cannot be previewed in the browser.
            <br />
            The file has been uploaded and will be analyzed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <iframe
      src={previewUrl}
      title={filename}
      className="w-full h-full border-0"
      style={{ background: "white" }}
    />
  );
}

// ── Section skeleton ────────────────────────────────────────────────────────────

function SkeletonLines({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2 animate-pulse">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-3 rounded-full bg-muted"
          style={{ width: `${70 + (i % 3) * 10}%` }}
        />
      ))}
    </div>
  );
}

// ── Analysis sections (left panel bottom) ──────────────────────────────────────

type AnalysisPhase = "upload" | "analyzing" | "results";

function AnalysisSections({
  phase,
  clauses,
  overallScore,
  analysisCost,
  expandedClause,
  setExpandedClause,
  canRedline,
}: {
  phase: AnalysisPhase;
  clauses: ClauseResult[];
  overallScore: number;
  analysisCost: AnalysisCost | null;
  expandedClause: string | null;
  setExpandedClause: (id: string | null) => void;
  canRedline: boolean;
}) {
  const highRisk = clauses.filter((c) => c.risk_level === "HIGH");
  const medRisk = clauses.filter((c) => c.risk_level === "MEDIUM");

  const sectionBase =
    "rounded-xl border border-border/60 bg-white overflow-hidden shadow-[0_1px_4px_rgba(0,0,0,0.04)]";

  if (phase === "upload") {
    return (
      <div className="space-y-3">
        {[
          { icon: BarChart3, label: "Summary" },
          { icon: ShieldAlert, label: "Risks" },
          { icon: ListChecks, label: "Key Clauses" },
        ].map(({ icon: Icon, label }) => (
          <div key={label} className={`${sectionBase} p-4`}>
            <div className="flex items-center gap-2 mb-3">
              <Icon className="h-4 w-4 text-muted-foreground/40" />
              <span className="text-[12px] font-semibold text-muted-foreground/50 uppercase tracking-wide">
                {label}
              </span>
            </div>
            <p className="text-[12px] text-muted-foreground/50">
              Upload a contract to see {label.toLowerCase()}.
            </p>
          </div>
        ))}
      </div>
    );
  }

  if (phase === "analyzing") {
    return (
      <div className="space-y-3">
        {[
          { icon: BarChart3, label: "Summary" },
          { icon: ShieldAlert, label: "Risks" },
          { icon: ListChecks, label: "Key Clauses" },
        ].map(({ icon: Icon, label, lines }: { icon: typeof BarChart3; label: string; lines?: number }) => (
          <div key={label} className={`${sectionBase} p-4`}>
            <div className="flex items-center gap-2 mb-3">
              <Icon className="h-4 w-4 text-muted-foreground/60" />
              <span className="text-[12px] font-semibold text-muted-foreground/60 uppercase tracking-wide">
                {label}
              </span>
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/40 ml-auto" />
            </div>
            <SkeletonLines count={lines ?? 3} />
          </div>
        ))}
      </div>
    );
  }

  // phase === "results"
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="space-y-3"
    >
      {/* Summary */}
      <div className={`${sectionBase} p-4 space-y-3`}>
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary/60" />
          <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground/50">
            Summary
          </span>
        </div>
        <RiskBar score={overallScore} />
        <div className="grid grid-cols-3 gap-2 pt-1">
          {[
            {
              label: "High Risk",
              value: highRisk.length,
              valueColor: "text-red-600",
              tile: highRisk.length > 0 ? "bg-red-50/70 border border-red-100/80" : "bg-muted/40",
            },
            {
              label: "Medium",
              value: medRisk.length,
              valueColor: "text-amber-500",
              tile: medRisk.length > 0 ? "bg-amber-50/60 border border-amber-100/80" : "bg-muted/40",
            },
            {
              label: "Total",
              value: clauses.length,
              valueColor: "text-foreground/80",
              tile: "bg-muted/40",
            },
          ].map(({ label, value, valueColor, tile }) => (
            <div key={label} className={`rounded-lg px-3 py-2.5 text-center ${tile}`}>
              <p className={`text-[15px] font-bold leading-none ${valueColor}`}>{value}</p>
              <p className="text-[10px] text-muted-foreground mt-1 leading-none">{label}</p>
            </div>
          ))}
        </div>
        {analysisCost && (
          <p className="text-[11px] text-muted-foreground/60 pt-1.5 border-t border-border/40">
            {analysisCost.actual_credits} credits used
          </p>
        )}
      </div>

      {/* Risks */}
      <div className={`${sectionBase} p-4`}>
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert className="h-4 w-4 text-red-400" />
          <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground/50">
            Risks
          </span>
          {[...highRisk, ...medRisk].length > 0 && (
            <span className="ml-auto text-[10px] font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded-full border border-red-100">
              {[...highRisk, ...medRisk].length}
            </span>
          )}
        </div>
        {[...highRisk, ...medRisk].length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No significant risks found.</p>
        ) : (
          <div className="space-y-2">
            {[...highRisk, ...medRisk].slice(0, 4).map((clause) => {
              const isHigh = clause.risk_level === "HIGH";
              return (
                <div
                  key={clause.id}
                  className={`rounded-lg border p-3 ${
                    isHigh
                      ? "bg-red-50/60 border-red-200/70"
                      : "bg-amber-50/50 border-amber-200/60"
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${isHigh ? "text-red-500" : "text-amber-500"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-[12px] font-semibold leading-tight flex-1 truncate">{clause.title}</p>
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${
                          isHigh ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-600"
                        }`}>
                          {clause.risk_level}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
                        {clause.explanation}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Key Clauses */}
      <div className={sectionBase}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40">
          <ListChecks className="h-4 w-4 text-primary/60" />
          <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground/50">
            Key Clauses
          </span>
          <span className="ml-auto text-[10px] font-semibold text-primary/60 bg-primary/8 px-1.5 py-0.5 rounded-full border border-primary/15">
            {clauses.length}
          </span>
        </div>
        <div className="divide-y divide-border/20">
          {clauses.map((clause, i) => {
            const isExpanded = expandedClause === clause.id;
            const isLocked = !canRedline && i >= 2;
            return (
              <div key={clause.id} className={isLocked ? "opacity-60" : ""}>
                <button
                  onClick={() => !isLocked && setExpandedClause(isExpanded ? null : clause.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors duration-150 ${
                    isLocked ? "cursor-default" : "hover:bg-primary/[0.03] cursor-pointer"
                  } ${isExpanded ? "bg-primary/[0.02]" : ""}`}
                >
                  <span
                    className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${
                      clause.risk_level === "HIGH"
                        ? "bg-red-50 text-red-600 border border-red-200"
                        : clause.risk_level === "MEDIUM"
                          ? "bg-amber-50 text-amber-600 border border-amber-200"
                          : "bg-green-50 text-green-600 border border-green-200"
                    }`}
                  >
                    {clause.risk_level}
                  </span>
                  <span className="text-[12px] font-medium flex-1 truncate text-foreground/85">{clause.title}</span>
                  {isLocked ? (
                    <Lock className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                  ) : isExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5 text-primary/60 shrink-0" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                  )}
                </button>
                <AnimatePresence>
                  {isExpanded && !isLocked && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <div className={`mx-4 mb-3 rounded-lg border p-3 space-y-2.5 ${
                        clause.risk_level === "HIGH"
                          ? "bg-red-50/40 border-red-200/50"
                          : clause.risk_level === "MEDIUM"
                            ? "bg-amber-50/40 border-amber-200/50"
                            : "bg-green-50/30 border-green-200/40"
                      }`}>
                        <p className="text-[12px] text-foreground/70 leading-relaxed">
                          {clause.explanation}
                        </p>
                        {clause.suggestion && (
                          <div className="rounded-md bg-primary/[0.05] border border-primary/10 p-2.5">
                            <p className="text-[10px] font-semibold text-primary/80 mb-1 uppercase tracking-widest">
                              Suggested Rewrite
                            </p>
                            <p className="text-[12px] text-foreground/70 leading-relaxed">
                              {clause.suggestion}
                            </p>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                {isLocked && (
                  <div className="px-4 pb-3">
                    <p className="text-[11px] text-muted-foreground/50 italic">
                      Upgrade to unlock full clause details
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

// ── Main upload component ──────────────────────────────────────────────────────

function UploadContent() {
  const { estimateCost, checkAffordability } = useAuth();
  const credits = useCredits();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  // ── File state ───────────────────────────────────────────────────────────────
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // ── Flow state ───────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<AnalysisPhase>("upload");
  const [currentStep, setCurrentStep] = useState(0);
  const [analysisCost, setAnalysisCost] = useState<AnalysisCost | null>(null);
  const [includeRedlines, setIncludeRedlines] = useState(false);
  const [expandedClause, setExpandedClause] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [contractId, setContractId] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [directResult, setDirectResult] = useState<AnalyzeContractResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReanalyzing, setIsReanalyzing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const estimated = estimateCost(1, includeRedlines, 6);
  const affordCheck = checkAffordability(estimated.estimated_credits);

  // Polling — activates when analysisId is set
  const pollingState = useAnalysisPolling(analysisId);

  // Revoke object URL on cleanup to avoid memory leaks
  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // React to polling result (mock mode)
  useEffect(() => {
    if (pollingState.status === "completed" && pollingState.analysis) {
      setAnalysisCost((prev) =>
        prev
          ? { ...prev, actual_credits: pollingState.creditsActual ?? prev.estimated_credits }
          : null,
      );
      setPhase("results");
      toast({ title: "Analysis complete", description: "Your contract has been analyzed." });
    } else if (pollingState.status === "failed") {
      setAnalysisError(pollingState.error ?? "Analysis failed. Please try again.");
      setAnalysisId(null);
      setPhase("upload");
    }
  }, [pollingState.status, pollingState.analysis, pollingState.creditsActual, pollingState.error, toast]);

  // ── File handlers ────────────────────────────────────────────────────────────

  const applyFile = useCallback((f: File) => {
    const err = validateFile(f);
    setFileError(err);
    if (err) return;
    setFile(f);
    setAnalysisError(null);
    // Instant local preview — works for PDF/TXT natively in the browser
    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
  }, [previewUrl]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) applyFile(dropped);
  }, [applyFile]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) applyFile(selected);
  }, [applyFile]);

  const handleRemoveFile = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setFile(null);
    setFileError(null);
    setAnalysisError(null);
    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [previewUrl]);

  // ── Re-analyze a contract that's already uploaded ────────────────────────────
  // Used by both the error retry path and the "Re-analyze" button in results phase.

  const handleReanalyze = useCallback(async (targetContractId: string) => {
    setIsReanalyzing(true);
    setPhase("analyzing");
    setCurrentStep(1); // skip Upload step — file already exists
    setAnalysisError(null);
    setAnalysisId(null);
    setDirectResult(null);

    try {
      setCurrentStep(2); // Generating results
      if (api.USE_MOCK) {
        const result = await api.startAnalysis(targetContractId, includeRedlines, 6);
        setAnalysisCost({ estimated_credits: result.estimated_credits, actual_credits: 0, breakdown: result.breakdown });
        setAnalysisId(result.analysis_id);
      } else {
        const result = await api.analyzeContract(targetContractId, includeRedlines);
        try {
          await saveDirectAnalysis(targetContractId, result);
        } catch (saveErr) {
          const msg = saveErr instanceof Error ? saveErr.message : "Could not save results";
          toast({ title: "Analysis completed but could not be saved", description: msg, variant: "destructive" });
          setPhase("upload");
          return;
        }
        queryClient.invalidateQueries({ queryKey: ["contracts"] });
        queryClient.invalidateQueries({ queryKey: ["direct-analysis", targetContractId] });
        setDirectResult(result);
        setPhase("results");
        if (result.error === "PARSE_FAILED") {
          toast({ title: "Could not read PDF", description: result.summary ?? undefined, variant: "destructive" });
        } else {
          toast({ title: "Re-analysis complete", description: "Your contract has been re-analyzed." });
        }
      }
    } catch (err: unknown) {
      setAnalysisError(cleanErrorMessage(err));
      setPhase("upload");
    } finally {
      setIsReanalyzing(false);
    }
  }, [includeRedlines, queryClient, toast]);

  // ── Analyze ──────────────────────────────────────────────────────────────────

  const handleAnalyze = useCallback(async () => {
    if (!affordCheck.allowed || !file) return;

    setIsSubmitting(true);
    setAnalysisError(null);

    // Transition to progress view after one tick so the button "Analyzing..."
    // state is briefly visible before the panel swaps
    await new Promise((r) => setTimeout(r, 0));
    setPhase("analyzing");
    setCurrentStep(0); // Step 0: Uploading
    setIsSubmitting(false);

    try {
      // ── Step 0: Upload ────────────────────────────────────────────────────
      const upload = await handleUpload(file);
      const uploadedContractId = upload.contract_id;
      setContractId(uploadedContractId);
      setCurrentStep(1); // Step 1: Processing

      if (api.USE_MOCK) {
        const result = await api.startAnalysis(uploadedContractId, includeRedlines, 6);
        setAnalysisCost({ estimated_credits: result.estimated_credits, actual_credits: 0, breakdown: result.breakdown });
        setCurrentStep(2);
        setAnalysisId(result.analysis_id);
      } else {
        setCurrentStep(2);
        const result = await api.analyzeContract(uploadedContractId, includeRedlines);
        try {
          await saveDirectAnalysis(uploadedContractId, result);
        } catch (saveErr) {
          const msg = saveErr instanceof Error ? saveErr.message : "Could not save results";
          toast({ title: "Analysis completed but could not be saved", description: msg, variant: "destructive" });
          setPhase("upload");
          return;
        }
        queryClient.invalidateQueries({ queryKey: ["contracts"] });
        queryClient.invalidateQueries({ queryKey: ["direct-analysis", uploadedContractId] });
        setDirectResult(result);
        setPhase("results");
        if (result.error === "PARSE_FAILED") {
          toast({ title: "Could not read PDF", description: result.summary ?? undefined, variant: "destructive" });
        } else {
          toast({ title: "Analysis complete", description: "Your contract has been analyzed." });
        }
      }
    } catch (err: unknown) {
      const message = cleanErrorMessage(err);
      if (err instanceof api.ApiError && err.status === 402) {
        toast({ title: "Insufficient credits", description: message, variant: "destructive" });
      } else {
        toast({ title: "Analysis failed", description: message, variant: "destructive" });
      }
      setAnalysisError(message);
      setPhase("upload");
    }
  }, [affordCheck, file, includeRedlines, queryClient, toast]);

  const analysis = pollingState.analysis;
  const clauses = analysis?.clauses ?? [];

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    // Break out of DashboardLayout's padding to fill the full content area
    <div className="-m-5 md:-m-7 lg:-m-8 flex flex-col md:flex-row md:h-[calc(100vh-3.5rem)]">

      {/* ── Left panel: Analysis ─────────────────────────────────────────── */}
      <div className="w-full md:w-[40%] md:min-w-[320px] flex flex-col border-b md:border-b-0 md:border-r border-border/50 bg-background md:overflow-y-auto">

        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 md:px-6 md:py-4 border-b border-border/40 bg-white/95 backdrop-blur-sm">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">Contract Analysis</h1>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {phase === "upload" && "Upload to begin"}
              {phase === "analyzing" && "Analyzing your contract…"}
              {phase === "results" && (
                directResult
                  ? `${directResult.clauses.length} clauses${directResult.risk_score != null ? ` · Risk score ${directResult.risk_score}` : ""}`
                  : `${clauses.length} clauses · Risk score ${analysis?.overall_score ?? 0}`
              )}
            </p>
          </div>
          {phase === "results" && (
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              {contractId && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px] gap-1.5"
                  onClick={() => handleReanalyze(contractId)}
                  disabled={isReanalyzing}
                  data-testid="reanalyze-btn"
                >
                  {isReanalyzing
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <RefreshCw className="h-3 w-3" />}
                  <span className="hidden sm:inline">{isReanalyzing ? "Analyzing…" : "Re-analyze"}</span>
                  <span className="sm:hidden">{isReanalyzing ? "…" : "Re-run"}</span>
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => {
                  setPhase("upload");
                  setFile(null);
                  if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
                  setPreviewUrl(null);
                  setAnalysisCost(null);
                  setAnalysisId(null);
                  setContractId(null);
                  setAnalysisError(null);
                  setDirectResult(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              >
                <span className="hidden sm:inline">New analysis</span>
                <span className="sm:hidden">New</span>
              </Button>
            </div>
          )}
        </div>

        <div className="flex-1 p-4 md:p-5 space-y-3 md:space-y-4">

          {/* ── Upload / File picker section ── */}
          {phase === "upload" && (
            <div className="space-y-3">
              {!affordCheck.allowed && credits.plan_id === "free" && (
                <UpgradeBanner feature="more credits" />
              )}

              {/* Hidden input */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={handleFileChange}
              />

              {/* Dropzone */}
              {!file ? (
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="upload-dropzone"
                  className={`group rounded-xl border-2 border-dashed p-8 text-center transition-all duration-200 cursor-pointer ${
                    dragging
                      ? "border-primary bg-primary/5 scale-[1.01]"
                      : "border-border hover:border-primary/40 hover:bg-muted/20 hover:scale-[1.005]"
                  } ${!affordCheck.allowed && credits.plan_id === "free" ? "opacity-50 pointer-events-none" : ""}`}
                >
                  <Upload className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2.5 transition-transform duration-200 group-hover:scale-110 group-hover:text-primary/50" />
                  <p className="text-[13px] font-medium mb-1">Drop your contract here</p>
                  <p className="text-[11px] text-muted-foreground/70">PDF only · up to 10 MB</p>
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-white p-4 transition-colors duration-200 hover:border-primary/20 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-primary/8 flex items-center justify-center shrink-0">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium truncate">{file.name}</p>
                      <p className="text-[11px] text-muted-foreground">{formatFileSize(file.size)}</p>
                    </div>
                    <button
                      onClick={handleRemoveFile}
                      className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-accent shrink-0"
                      data-testid="remove-file-btn"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {fileError && <p className="text-[11px] text-red-500">{fileError}</p>}

              {/* Analysis error + retry */}
              {analysisError && !fileError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-start gap-2.5">
                  <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-red-700">Analysis failed</p>
                    <p className="text-[11px] text-red-600 mt-0.5 leading-relaxed">{analysisError}</p>
                  </div>
                  {contractId && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] border-red-200 text-red-600 hover:bg-red-100 shrink-0"
                      onClick={() => handleReanalyze(contractId!)}
                      data-testid="retry-analysis-btn"
                    >
                      <RefreshCw className="h-3 w-3 mr-1" /> Retry
                    </Button>
                  )}
                </div>
              )}

              {/* Credit cost + Analyze CTA */}
              {file && !fileError && (
                <div className="rounded-xl border border-border bg-white p-4 space-y-3 shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
                  <div className="flex items-center gap-2">
                    <Coins className="h-4 w-4 text-primary" />
                    <span className="text-[12px] font-semibold">Estimated Cost</span>
                  </div>
                  <div className="space-y-1.5">
                    {estimated.breakdown.map((item, i) => (
                      <div key={i} className="flex items-center justify-between text-[12px]">
                        <span className="text-muted-foreground">{item.label}</span>
                        <span className="font-medium">{item.credits} credits</span>
                      </div>
                    ))}
                    <div className="border-t border-border/40 pt-1.5 flex items-center justify-between text-[12px] font-semibold">
                      <span>Total</span>
                      <span className="text-primary">{estimated.estimated_credits} credits</span>
                    </div>
                  </div>
                  {credits.can_redline && (
                    <label className="flex items-center gap-2 text-[12px] text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeRedlines}
                        onChange={(e) => setIncludeRedlines(e.target.checked)}
                        className="rounded border-border"
                      />
                      Include redlines (+{6 * credits.CREDIT_COSTS.REDLINE} credits)
                    </label>
                  )}
                  {!affordCheck.allowed && (
                    <p className="text-[11px] text-red-500">{affordCheck.reason}</p>
                  )}
                  <Button
                    onClick={handleAnalyze}
                    className="w-full h-10"
                    disabled={!affordCheck.allowed || isSubmitting}
                    data-testid="analyze-btn"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Analyzing...
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-2 h-4 w-4" />
                        Analyze Contract ({estimated.estimated_credits} credits)
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* ── Analyzing progress ── */}
          {phase === "analyzing" && (
            <div className="rounded-xl border border-border bg-white p-5">
              <div className="flex flex-col items-center mb-5">
                {pollingState.backendStatus === "queued" ? (
                  <div className="h-9 w-9 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-3">
                    <Clock className="h-4.5 w-4.5 text-amber-500" />
                  </div>
                ) : (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                    className="h-9 w-9 rounded-full border-2 border-primary border-t-transparent mb-3"
                  />
                )}
                <p className="text-[13px] font-semibold">
                  {pollingState.backendStatus === "queued" ? "Queued" : "Analyzing"}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {pollingState.backendStatus === "queued"
                    ? "Waiting for a worker…"
                    : "Usually 10–30 seconds"}
                </p>
              </div>
              <div className="space-y-2">
                {ANALYSIS_STEPS.map((step, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: i <= currentStep ? 1 : 0.2, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex items-center gap-2.5"
                  >
                    {i < currentStep ? (
                      <div className="h-4 w-4 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <Check className="h-2.5 w-2.5 text-primary" />
                      </div>
                    ) : i === currentStep ? (
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                        className="h-4 w-4 rounded-full border-[1.5px] border-primary border-t-transparent shrink-0"
                      />
                    ) : (
                      <div className="h-4 w-4 rounded-full border border-border shrink-0" />
                    )}
                    <span className={`text-[12px] ${i <= currentStep ? "text-foreground" : "text-muted-foreground/30"}`}>
                      {step}
                    </span>
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {/* ── Direct result (real API mode) ── */}
          {phase === "results" && directResult && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="space-y-3"
            >
              <div className="rounded-xl border border-border/60 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.04)] p-4 space-y-2">
                <div className="flex items-center gap-2 mb-1">
                  <BarChart3 className="h-4 w-4 text-primary/60" />
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground/50">Summary</span>
                </div>
                <p className="text-[13px] text-foreground/75 leading-relaxed">{directResult.summary}</p>
              </div>
              <div className="rounded-xl border border-border/60 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.04)] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <ShieldAlert className="h-4 w-4 text-red-400" />
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground/50">Risks</span>
                  <span className="ml-auto text-[10px] font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded-full border border-red-100">
                    {directResult.risks.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {directResult.risks.map((risk, i) => (
                    <div key={i} className="flex items-start gap-2.5 rounded-lg bg-amber-50/60 border border-amber-200/60 px-3 py-2.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
                      <span className="text-[12px] text-foreground/80 leading-relaxed">{risk}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-border/60 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.04)] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <ListChecks className="h-4 w-4 text-primary/60" />
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground/50">Key Clauses</span>
                  <span className="ml-auto text-[10px] font-semibold text-primary/70 bg-primary/8 px-1.5 py-0.5 rounded-full border border-primary/15">
                    {directResult.clauses.length}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {directResult.clauses.map((clause, i) => (
                    <div key={i} className="flex items-center gap-2.5 rounded-md bg-muted/30 border border-border/40 px-3 py-2 transition-colors duration-150 hover:bg-muted/50">
                      <div className="h-4 w-4 rounded-full bg-green-50 border border-green-200 flex items-center justify-center shrink-0">
                        <Check className="h-2.5 w-2.5 text-green-600" />
                      </div>
                      <span className="text-[12px] text-foreground/75">{clause}</span>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {/* ── Analysis sections (mock polling mode) ── */}
          {!directResult && (
            <AnalysisSections
              phase={phase}
              clauses={clauses}
              overallScore={analysis?.overall_score ?? 0}
              analysisCost={analysisCost}
              expandedClause={expandedClause}
              setExpandedClause={setExpandedClause}
              canRedline={credits.can_redline}
            />
          )}

          {/* View reports link after results */}
          {phase === "results" && (
            <Button
              variant="outline"
              size="sm"
              className="w-full text-[12px]"
              onClick={() => setLocation("/reports")}
              data-testid="view-reports-btn"
            >
              View all reports
            </Button>
          )}
        </div>
      </div>

      {/* ── Right panel: Contract viewer ─────────────────────────────────── */}
      <div className="w-full md:flex-1 flex flex-col overflow-hidden bg-muted/20">
        {/* Viewer header */}
        <div className="flex items-center gap-3 px-4 md:px-5 h-12 md:h-[53px] border-b border-border/40 bg-white/90 backdrop-blur-sm shrink-0">
          <FileText className="h-4 w-4 text-muted-foreground/50 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-[12px] text-muted-foreground truncate block">
              {file ? file.name : "Contract Preview"}
            </span>
            {/* Mobile-only subtitle */}
            {!file && (
              <span className="text-[10px] text-muted-foreground/50 md:hidden">
                Upload a contract to preview it here
              </span>
            )}
          </div>
          {file && (
            <span className="ml-auto text-[11px] text-muted-foreground/50 shrink-0">
              {formatFileSize(file.size)}
            </span>
          )}
        </div>

        {/* Viewer body */}
        <div className="h-[50vh] md:h-auto md:flex-1 overflow-auto">
          <ContractViewer previewUrl={previewUrl} filename={file?.name ?? null} />
        </div>
      </div>
    </div>
  );
}

export default function UploadPage() {
  return (
    <DashboardLayout>
      <UploadContent />
    </DashboardLayout>
  );
}
