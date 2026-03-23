import { useState, useCallback, useRef, useEffect } from "react";
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
import type { AnalysisCost } from "@/lib/credits";

// ── File validation ───────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function validateFile(f: File): string | null {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (!["pdf", "docx", "txt"].includes(ext)) {
    return "Only PDF, DOCX, or TXT files are supported.";
  }
  if (f.size > MAX_FILE_SIZE) {
    return `File too large. Max size is 10MB (got ${(f.size / (1024 * 1024)).toFixed(1)} MB).`;
  }
  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Component ─────────────────────────────────────────────────────────────────

function UploadContent() {
  const { estimateCost, checkAffordability } = useAuth();
  const credits = useCredits();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<"upload" | "analyzing" | "results">("upload");
  const [currentStep, setCurrentStep] = useState(0);
  const [analysisCost, setAnalysisCost] = useState<AnalysisCost | null>(null);
  const [includeRedlines, setIncludeRedlines] = useState(false);
  const [expandedClause, setExpandedClause] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [contractId, setContractId] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const stepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const estimated = estimateCost(1, includeRedlines, 6);
  const affordCheck = checkAffordability(estimated.estimated_credits);

  // Polling — activates when analysisId is set
  const pollingState = useAnalysisPolling(analysisId);

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
      const errMsg = pollingState.error ?? "Analysis failed. Please try again.";
      setAnalysisError(errMsg);
      // Keep contractId so the retry button can re-submit without re-uploading
      setAnalysisId(null);
      setPhase("upload");
    }
  }, [pollingState.status, pollingState.analysis, pollingState.creditsActual, pollingState.error, toast]);

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (stepIntervalRef.current) clearInterval(stepIntervalRef.current);
    };
  }, []);

  // ── File handlers ──────────────────────────────────────────────────────────

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (!dropped) return;
    const err = validateFile(dropped);
    setFileError(err);
    if (!err) setFile(dropped);
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    const err = validateFile(selected);
    setFileError(err);
    if (!err) setFile(selected);
  }, []);

  const handleRemoveFile = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setFile(null);
    setFileError(null);
    setAnalysisError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // ── Retry (re-submit with existing contractId, no re-upload) ──────────────

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
      setAnalysisCost({
        estimated_credits: result.estimated_credits,
        actual_credits: 0,
        breakdown: result.breakdown,
      });
      setAnalysisId(result.analysis_id);
    } catch (err: unknown) {
      if (stepIntervalRef.current) {
        clearInterval(stepIntervalRef.current);
        stepIntervalRef.current = null;
      }
      const message = err instanceof Error ? err.message : "Analysis failed. Please try again.";
      setAnalysisError(message);
      setPhase("upload");
    }
  }, [contractId, includeRedlines]);

  // ── Analyze ────────────────────────────────────────────────────────────────

  const handleAnalyze = useCallback(async () => {
    if (!affordCheck.allowed || !file) return;
    setPhase("analyzing");
    setCurrentStep(0);
    setAnalysisError(null);

    // Cosmetic step animation — runs independently of real polling
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
      // Step 1: Upload file (409 = duplicate, re-use existing contract_id)
      const formData = new FormData();
      formData.append("file", file);
      let uploadedContractId: string;
      try {
        const upload = await api.uploadContract(formData);
        uploadedContractId = upload.contract_id;
      } catch (err) {
        if (err instanceof api.ApiError && err.status === 409) {
          // Server returns { contract_id } on duplicate — re-use it
          uploadedContractId = (err.data?.contract_id as string) ?? "";
          if (!uploadedContractId) throw err;
        } else {
          throw err;
        }
      }
      setContractId(uploadedContractId);

      // Step 2: Queue analysis — returns analysis_id immediately (202 Accepted)
      const result = await api.startAnalysis(uploadedContractId, includeRedlines, 6);
      setAnalysisCost({
        estimated_credits: result.estimated_credits,
        actual_credits: 0,
        breakdown: result.breakdown,
      });

      // Step 3: Start polling — drives phase transition to "results"
      setAnalysisId(result.analysis_id);
    } catch (err: unknown) {
      if (stepIntervalRef.current) {
        clearInterval(stepIntervalRef.current);
        stepIntervalRef.current = null;
      }
      const message = err instanceof Error ? err.message : "Analysis failed. Please try again.";

      // 402 = insufficient credits — surface clearly
      if (err instanceof api.ApiError && err.status === 402) {
        toast({ title: "Insufficient credits", description: message, variant: "destructive" });
      } else {
        toast({ title: "Analysis failed", description: message, variant: "destructive" });
      }

      setAnalysisError(message);
      setPhase("upload");
    }
  }, [affordCheck, file, includeRedlines, toast]);

  // ── Derived display data ───────────────────────────────────────────────────

  const analysis = pollingState.analysis;
  const clauses = analysis?.clauses ?? [];

  return (
    <div className="max-w-[780px] space-y-6">
      <div>
        <h1 className="text-xl font-semibold mb-1">Upload Contract</h1>
        <p className="text-sm text-muted-foreground">
          Upload a contract document and let AI analyze the risks.
        </p>
      </div>

      {!affordCheck.allowed && credits.plan_id === "free" && (
        <UpgradeBanner feature="more credits" />
      )}

      <AnimatePresence mode="wait">
        {/* ── Upload phase ── */}
        {phase === "upload" && (
          <motion.div
            key="upload"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-4"
          >
            {/* Hidden real file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt"
              className="hidden"
              onChange={handleFileChange}
            />

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`rounded-xl border-2 border-dashed p-12 text-center transition-all cursor-pointer ${
                dragging
                  ? "border-primary bg-primary/5"
                  : file
                    ? "border-primary/30 bg-primary/[0.02]"
                    : "border-border hover:border-primary/30"
              } ${
                !affordCheck.allowed && credits.plan_id === "free"
                  ? "opacity-50 pointer-events-none"
                  : ""
              }`}
              data-testid="upload-dropzone"
            >
              {file ? (
                <div className="flex items-center justify-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/8 flex items-center justify-center">
                    <FileText className="h-5 w-5 text-primary" />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                  </div>
                  <button
                    onClick={handleRemoveFile}
                    className="ml-3 h-7 w-7 rounded-md flex items-center justify-center hover:bg-accent"
                    data-testid="remove-file-btn"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
                  <p className="text-sm font-medium mb-1">
                    Drop your contract here, or click to browse
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Supports PDF and DOCX up to 10MB
                  </p>
                </>
              )}
            </div>

            {fileError && (
              <p className="text-[11px] text-red-500">{fileError}</p>
            )}

            {analysisError && !fileError && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-start gap-3">
                <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-red-700 mb-1">Analysis failed</p>
                  <p className="text-[11px] text-red-600 leading-relaxed">{analysisError}</p>
                </div>
                {contractId && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 h-7 text-[11px] border-red-200 text-red-600 hover:bg-red-100"
                    onClick={handleRetry}
                    data-testid="retry-analysis-btn"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" /> Retry
                  </Button>
                )}
              </div>
            )}

            {file && !fileError && (
              <>
                {/* Credit cost estimation */}
                <div className="rounded-xl border border-border bg-white p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Coins className="h-4 w-4 text-primary" />
                    <span className="text-[13px] font-medium">Estimated Credit Cost</span>
                  </div>
                  <div className="space-y-1.5 mb-3">
                    {estimated.breakdown.map((item, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between text-[12px]"
                      >
                        <span className="text-muted-foreground">{item.label}</span>
                        <span className="font-medium">{item.credits} credits</span>
                      </div>
                    ))}
                    <div className="border-t border-border/40 pt-1.5 flex items-center justify-between text-[12px] font-semibold">
                      <span>Total</span>
                      <span className="text-primary">
                        {estimated.estimated_credits} credits
                      </span>
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
                      Include redline suggestions (+{6 * credits.CREDIT_COSTS.REDLINE} credits)
                    </label>
                  )}
                  {!affordCheck.allowed && (
                    <p className="text-[11px] text-red-500 mt-2">{affordCheck.reason}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-2">
                    Balance after:{" "}
                    {Math.max(0, credits.credits_remaining - estimated.estimated_credits)}{" "}
                    credits
                  </p>
                </div>

                <Button
                  onClick={handleAnalyze}
                  className="w-full h-11"
                  disabled={!affordCheck.allowed}
                  data-testid="analyze-btn"
                >
                  <Sparkles className="mr-2 h-4 w-4" /> Analyze Contract (
                  {estimated.estimated_credits} credits)
                </Button>
              </>
            )}
          </motion.div>
        )}

        {/* ── Analyzing phase ── */}
        {phase === "analyzing" && (
          <motion.div
            key="analyzing"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-xl border border-border bg-white p-8"
          >
            <div className="flex flex-col items-center mb-7">
              {pollingState.backendStatus === "queued" ? (
                <div className="h-10 w-10 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-4">
                  <Clock className="h-5 w-5 text-amber-500" />
                </div>
              ) : (
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  className="h-10 w-10 rounded-full border-2 border-primary border-t-transparent mb-4"
                />
              )}
              <h3 className="text-sm font-semibold mb-1">
                {pollingState.backendStatus === "queued"
                  ? "Queued"
                  : "Analyzing Contract"}
              </h3>
              <p className="text-xs text-muted-foreground">
                {pollingState.backendStatus === "queued"
                  ? "Waiting for a worker to pick up your job…"
                  : "This usually takes 10–30 seconds"}
              </p>
            </div>
            <div className="max-w-xs mx-auto space-y-2.5">
              {demoSteps.map((step, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: i <= currentStep ? 1 : 0.2, x: 0 }}
                  transition={{ delay: i * 0.06 }}
                  className="flex items-center gap-3"
                >
                  {i < currentStep ? (
                    <div className="h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center">
                      <Check className="h-3 w-3 text-primary" />
                    </div>
                  ) : i === currentStep ? (
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                      className="h-5 w-5 rounded-full border-2 border-primary border-t-transparent"
                    />
                  ) : (
                    <div className="h-5 w-5 rounded-full border border-border" />
                  )}
                  <span
                    className={`text-[12px] ${i <= currentStep ? "text-foreground" : "text-muted-foreground/30"}`}
                  >
                    {step}
                  </span>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}

        {/* ── Results phase ── */}
        {phase === "results" && (
          <motion.div
            key="results"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-6"
          >
            {/* Risk bar + credit cost summary */}
            <div className="rounded-xl border border-border bg-white p-6 space-y-4">
              <RiskBar score={analysis?.overall_score ?? 0} />
              <div className="flex items-start justify-between pt-2 border-t border-border/40">
                <div>
                  <p className="text-sm font-semibold">Overall Risk Assessment</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {clauses.filter((c) => c.risk_level === "HIGH").length} high-risk,{" "}
                    {clauses.filter((c) => c.risk_level === "MEDIUM").length} medium-risk clauses
                  </p>
                </div>
                {analysisCost && (
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Credits used</p>
                    <p className="text-sm font-semibold text-primary">
                      {analysisCost.actual_credits}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Clauses */}
            <div>
              <h2 className="text-sm font-semibold mb-3">Clause Analysis</h2>
              <div className="space-y-2">
                {clauses.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No clauses found in this contract.
                  </p>
                ) : (
                  clauses.map((clause, i) => {
                    const isExpanded = expandedClause === clause.id;
                    const isLocked = !credits.can_redline && i >= 2;
                    const riskClass = clause.risk_level.toLowerCase();
                    return (
                      <motion.div
                        key={clause.id}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.04, duration: 0.25 }}
                        className={`rounded-xl border overflow-hidden bg-white ${
                          clause.risk_level === "HIGH"
                            ? "border-red-200"
                            : clause.risk_level === "MEDIUM"
                              ? "border-amber-200"
                              : "border-green-200"
                        }`}
                      >
                        <button
                          onClick={() =>
                            !isLocked &&
                            setExpandedClause(isExpanded ? null : clause.id)
                          }
                          className="w-full flex items-center gap-3 p-4 text-left"
                          data-testid={`clause-${clause.id}`}
                        >
                          <AlertTriangle
                            className={`h-4 w-4 shrink-0 risk-${riskClass}`}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-medium">{clause.title}</p>
                            <p className="text-[12px] text-muted-foreground truncate mt-0.5">
                              {clause.text}
                            </p>
                          </div>
                          <span
                            className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full ${
                              clause.risk_level === "HIGH"
                                ? "bg-red-50 text-red-600"
                                : clause.risk_level === "MEDIUM"
                                  ? "bg-amber-50 text-amber-600"
                                  : "bg-green-50 text-green-600"
                            }`}
                          >
                            {clause.risk_level}
                          </span>
                          {isLocked ? (
                            <Lock className="h-4 w-4 text-muted-foreground shrink-0" />
                          ) : isExpanded ? (
                            <ChevronUp className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          )}
                        </button>

                        <AnimatePresence>
                          {isExpanded && !isLocked && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="border-t border-border/40"
                            >
                              <div className="p-4 space-y-3">
                                <div>
                                  <p className="text-[11px] font-medium text-muted-foreground mb-1">
                                    Explanation
                                  </p>
                                  <p className="text-[13px] text-foreground/80 leading-relaxed">
                                    {clause.explanation}
                                  </p>
                                </div>
                                {clause.suggestion && (
                                  <div className="rounded-lg bg-primary/[0.03] border border-primary/10 p-3">
                                    <p className="text-[11px] font-medium text-primary mb-1">
                                      Suggested Rewrite
                                    </p>
                                    <p className="text-[13px] text-foreground/80 leading-relaxed">
                                      {clause.suggestion}
                                    </p>
                                  </div>
                                )}
                                {clause.issues.length > 0 && (
                                  <div>
                                    <p className="text-[11px] font-medium text-muted-foreground mb-1">
                                      Issues
                                    </p>
                                    <ul className="space-y-1">
                                      {clause.issues.map((issue, j) => (
                                        <li
                                          key={j}
                                          className="text-[12px] text-foreground/70 leading-relaxed"
                                        >
                                          • {issue}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>

                        {isLocked && (
                          <div className="px-4 pb-3">
                            <div className="rounded-lg bg-muted/50 p-3 flex items-center gap-2">
                              <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-[12px] text-muted-foreground">
                                Upgrade to Starter or above for redline access
                              </span>
                            </div>
                          </div>
                        )}
                      </motion.div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPhase("upload");
                  setFile(null);
                  setAnalysisCost(null);
                  setAnalysisId(null);
                  setContractId(null);
                  setAnalysisError(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                data-testid="analyze-another-btn"
              >
                Analyze Another
              </Button>
              <Button
                size="sm"
                onClick={() => setLocation("/reports")}
                data-testid="view-reports-btn"
              >
                View Reports
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
