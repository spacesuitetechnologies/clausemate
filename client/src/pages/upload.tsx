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
import { demoSteps } from "@/lib/mock-data";
import * as api from "@/lib/api";
import { handleUpload } from "@/lib/upload";
import { saveDirectAnalysis } from "@/lib/analyses";
import type { AnalysisCost } from "@/lib/credits";
import type { ClauseResult } from "@/types/analysis";
import type { AnalyzeContractResult } from "@/lib/api";

// ── File validation ────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024;

function validateFile(f: File): string | null {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (!["pdf", "docx", "txt"].includes(ext)) {
    return "Only PDF, DOCX, or TXT files are supported.";
  }
  if (f.size > MAX_FILE_SIZE) {
    return `File too large. Max size is 10 MB (got ${(f.size / 1024 / 1024).toFixed(1)} MB).`;
  }
  return null;
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
    "rounded-xl border border-border/60 bg-white overflow-hidden";

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
    <div className="space-y-3">
      {/* Summary */}
      <div className={`${sectionBase} p-4 space-y-3`}>
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary/70" />
          <span className="text-[12px] font-semibold uppercase tracking-wide text-foreground/70">
            Summary
          </span>
        </div>
        <RiskBar score={overallScore} />
        <div className="grid grid-cols-3 gap-2 pt-1">
          {[
            { label: "High Risk", value: highRisk.length, color: "text-red-600" },
            { label: "Medium", value: medRisk.length, color: "text-amber-500" },
            { label: "Total", value: clauses.length, color: "text-muted-foreground" },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-lg bg-muted/40 px-3 py-2 text-center">
              <p className={`text-base font-bold ${color}`}>{value}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
            </div>
          ))}
        </div>
        {analysisCost && (
          <p className="text-[11px] text-muted-foreground pt-1 border-t border-border/40">
            {analysisCost.actual_credits} credits used
          </p>
        )}
      </div>

      {/* Risks */}
      <div className={`${sectionBase} p-4`}>
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert className="h-4 w-4 text-primary/70" />
          <span className="text-[12px] font-semibold uppercase tracking-wide text-foreground/70">
            Risks
          </span>
        </div>
        {[...highRisk, ...medRisk].length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No significant risks found.</p>
        ) : (
          <div className="space-y-2">
            {[...highRisk, ...medRisk].slice(0, 4).map((clause) => (
              <div
                key={clause.id}
                className="flex items-start gap-2.5 p-2.5 rounded-lg bg-muted/30 border border-border/40"
              >
                <span
                  className={`mt-0.5 h-4 w-4 shrink-0 rounded-full flex items-center justify-center text-[9px] font-bold ${
                    clause.risk_level === "HIGH"
                      ? "bg-red-100 text-red-600"
                      : "bg-amber-100 text-amber-600"
                  }`}
                >
                  !
                </span>
                <div className="min-w-0">
                  <p className="text-[12px] font-medium leading-tight truncate">{clause.title}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
                    {clause.explanation}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Key Clauses */}
      <div className={sectionBase}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40">
          <ListChecks className="h-4 w-4 text-primary/70" />
          <span className="text-[12px] font-semibold uppercase tracking-wide text-foreground/70">
            Key Clauses
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">{clauses.length} found</span>
        </div>
        <div className="divide-y divide-border/30">
          {clauses.map((clause, i) => {
            const isExpanded = expandedClause === clause.id;
            const isLocked = !canRedline && i >= 2;
            return (
              <div key={clause.id}>
                <button
                  onClick={() => !isLocked && setExpandedClause(isExpanded ? null : clause.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                >
                  <span
                    className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${
                      clause.risk_level === "HIGH"
                        ? "bg-red-50 text-red-600"
                        : clause.risk_level === "MEDIUM"
                          ? "bg-amber-50 text-amber-600"
                          : "bg-green-50 text-green-600"
                    }`}
                  >
                    {clause.risk_level}
                  </span>
                  <span className="text-[12px] font-medium flex-1 truncate">{clause.title}</span>
                  {isLocked ? (
                    <Lock className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                  ) : isExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                </button>
                <AnimatePresence>
                  {isExpanded && !isLocked && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-3 space-y-2">
                        <p className="text-[12px] text-foreground/75 leading-relaxed">
                          {clause.explanation}
                        </p>
                        {clause.suggestion && (
                          <div className="rounded-lg bg-primary/[0.04] border border-primary/10 p-2.5">
                            <p className="text-[10px] font-semibold text-primary mb-1 uppercase tracking-wide">
                              Suggested Rewrite
                            </p>
                            <p className="text-[12px] text-foreground/75 leading-relaxed">
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
                    <p className="text-[11px] text-muted-foreground/60">
                      Upgrade to Starter to unlock full clause details
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const stepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // React to polling result
  useEffect(() => {
    if (pollingState.status === "completed" && pollingState.analysis) {
      if (stepIntervalRef.current) {
        clearInterval(stepIntervalRef.current);
        stepIntervalRef.current = null;
      }
      setAnalysisCost((prev) =>
        prev
          ? { ...prev, actual_credits: pollingState.creditsActual ?? prev.estimated_credits }
          : null,
      );
      setPhase("results");
    } else if (pollingState.status === "failed") {
      if (stepIntervalRef.current) {
        clearInterval(stepIntervalRef.current);
        stepIntervalRef.current = null;
      }
      setAnalysisError(pollingState.error ?? "Analysis failed. Please try again.");
      setAnalysisId(null);
      setPhase("upload");
    }
  }, [pollingState.status, pollingState.analysis, pollingState.creditsActual, pollingState.error]);

  useEffect(() => {
    return () => { if (stepIntervalRef.current) clearInterval(stepIntervalRef.current); };
  }, []);

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

  // ── Retry ────────────────────────────────────────────────────────────────────

  const handleRetry = useCallback(async () => {
    if (!contractId) return;
    setPhase("analyzing");
    setCurrentStep(0);
    setAnalysisError(null);
    setAnalysisId(null);

    let step = 0;
    stepIntervalRef.current = setInterval(() => {
      step++;
      setCurrentStep(step);
      if (step >= demoSteps.length - 1) {
        clearInterval(stepIntervalRef.current!);
        stepIntervalRef.current = null;
      }
    }, 800);

    try {
      const result = await api.startAnalysis(contractId, includeRedlines, 6);
      setAnalysisCost({ estimated_credits: result.estimated_credits, actual_credits: 0, breakdown: result.breakdown });
      setAnalysisId(result.analysis_id);
    } catch (err: unknown) {
      if (stepIntervalRef.current) { clearInterval(stepIntervalRef.current); stepIntervalRef.current = null; }
      setAnalysisError(err instanceof Error ? err.message : "Analysis failed. Please try again.");
      setPhase("upload");
    }
  }, [contractId, includeRedlines]);

  // ── Analyze ──────────────────────────────────────────────────────────────────

  const handleAnalyze = useCallback(async () => {
    if (!affordCheck.allowed || !file) return;
    setPhase("analyzing");
    setCurrentStep(0);
    setAnalysisError(null);

    let step = 0;
    stepIntervalRef.current = setInterval(() => {
      step++;
      setCurrentStep(step);
      if (step >= demoSteps.length - 1) {
        clearInterval(stepIntervalRef.current!);
        stepIntervalRef.current = null;
      }
    }, 800);

    try {
      const upload = await handleUpload(file);
      const uploadedContractId = upload.contract_id;
      setContractId(uploadedContractId);

      if (api.USE_MOCK) {
        const result = await api.startAnalysis(uploadedContractId, includeRedlines, 6);
        setAnalysisCost({ estimated_credits: result.estimated_credits, actual_credits: 0, breakdown: result.breakdown });
        setAnalysisId(result.analysis_id);
      } else {
        const result = await api.analyzeContract(uploadedContractId);
        if (stepIntervalRef.current) { clearInterval(stepIntervalRef.current); stepIntervalRef.current = null; }

        // Persist to Supabase so results appear in Reports
        try {
          await saveDirectAnalysis(uploadedContractId, result);
          queryClient.invalidateQueries({ queryKey: ["contracts"] });
          queryClient.invalidateQueries({ queryKey: ["direct-analysis", uploadedContractId] });
        } catch {
          // Save failure is non-fatal — results still shown in current session
        }

        setDirectResult(result);
        setPhase("results");
      }
    } catch (err: unknown) {
      if (stepIntervalRef.current) { clearInterval(stepIntervalRef.current); stepIntervalRef.current = null; }
      const message = err instanceof Error ? err.message : "Analysis failed. Please try again.";
      if (err instanceof api.ApiError && err.status === 402) {
        toast({ title: "Insufficient credits", description: message, variant: "destructive" });
      } else {
        toast({ title: "Analysis failed", description: message, variant: "destructive" });
      }
      setAnalysisError(message);
      setPhase("upload");
    }
  }, [affordCheck, file, includeRedlines, toast]);

  const analysis = pollingState.analysis;
  const clauses = analysis?.clauses ?? [];

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    // Break out of DashboardLayout's padding to fill the full content area
    <div className="-m-5 md:-m-7 lg:-m-8 flex flex-col md:flex-row md:h-[calc(100vh-3.5rem)] overflow-x-hidden">

      {/* ── Left panel: Analysis ─────────────────────────────────────────── */}
      <div className="w-full md:w-[40%] md:min-w-[320px] flex flex-col border-b md:border-b-0 md:border-r border-border/50 bg-background md:overflow-y-auto">

        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-border/40 bg-background/95 backdrop-blur-sm">
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">Contract Analysis</h1>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {phase === "upload" && "Upload to begin"}
              {phase === "analyzing" && "Analyzing your contract…"}
              {phase === "results" && `${clauses.length} clauses · Risk score ${analysis?.overall_score ?? 0}`}
            </p>
          </div>
          {phase === "results" && (
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
              New analysis
            </Button>
          )}
        </div>

        <div className="flex-1 p-5 space-y-4">

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
                accept=".pdf,.docx,.txt"
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
                  className={`rounded-xl border-2 border-dashed p-8 text-center transition-all cursor-pointer ${
                    dragging
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/30 hover:bg-muted/30"
                  } ${!affordCheck.allowed && credits.plan_id === "free" ? "opacity-50 pointer-events-none" : ""}`}
                >
                  <Upload className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2.5" />
                  <p className="text-[13px] font-medium mb-1">Drop your contract here</p>
                  <p className="text-[11px] text-muted-foreground">PDF · DOCX · TXT · up to 10 MB</p>
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-white p-4">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-primary/8 flex items-center justify-center shrink-0">
                      <FileText className="h-4.5 w-4.5 text-primary" />
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
                      onClick={handleRetry}
                      data-testid="retry-analysis-btn"
                    >
                      <RefreshCw className="h-3 w-3 mr-1" /> Retry
                    </Button>
                  )}
                </div>
              )}

              {/* Credit cost + Analyze CTA */}
              {file && !fileError && (
                <div className="rounded-xl border border-border bg-white p-4 space-y-3">
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
                    disabled={!affordCheck.allowed}
                    data-testid="analyze-btn"
                  >
                    <Sparkles className="mr-2 h-4 w-4" />
                    Analyze Contract ({estimated.estimated_credits} credits)
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
                {demoSteps.map((step, i) => (
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
            <div className="space-y-3">
              <div className="rounded-xl border border-border/60 bg-white p-4 space-y-2">
                <div className="flex items-center gap-2 mb-1">
                  <BarChart3 className="h-4 w-4 text-primary/70" />
                  <span className="text-[12px] font-semibold uppercase tracking-wide text-foreground/70">Summary</span>
                </div>
                <p className="text-[12px] text-muted-foreground leading-relaxed">{directResult.summary}</p>
              </div>
              <div className="rounded-xl border border-border/60 bg-white p-4 space-y-2">
                <div className="flex items-center gap-2 mb-1">
                  <ShieldAlert className="h-4 w-4 text-primary/70" />
                  <span className="text-[12px] font-semibold uppercase tracking-wide text-foreground/70">Risks</span>
                </div>
                <ul className="space-y-1.5">
                  {directResult.risks.map((risk, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full bg-red-100 flex items-center justify-center text-[9px] font-bold text-red-600">!</span>
                      <span className="text-[12px] text-muted-foreground">{risk}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-border/60 bg-white p-4 space-y-2">
                <div className="flex items-center gap-2 mb-1">
                  <ListChecks className="h-4 w-4 text-primary/70" />
                  <span className="text-[12px] font-semibold uppercase tracking-wide text-foreground/70">Key Clauses</span>
                </div>
                <ul className="space-y-1.5">
                  {directResult.clauses.map((clause, i) => (
                    <li key={i} className="flex items-center gap-2 text-[12px] text-muted-foreground">
                      <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      {clause}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
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
        <div className="flex items-center gap-3 px-5 h-[53px] border-b border-border/40 bg-white/80 backdrop-blur-sm shrink-0">
          <FileText className="h-4 w-4 text-muted-foreground/50 shrink-0" />
          <span className="text-[12px] text-muted-foreground truncate">
            {file ? file.name : "No contract loaded"}
          </span>
          {file && (
            <span className="ml-auto text-[11px] text-muted-foreground/50 shrink-0">
              {formatFileSize(file.size)}
            </span>
          )}
        </div>

        {/* Viewer body */}
        <div className="h-[60vh] md:h-auto md:flex-1 overflow-auto">
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
