import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import {
  FileSignature, ArrowRight, ArrowLeft, Loader2, Lock,
  Copy, ClipboardCheck, Download, RefreshCw, CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardLayout } from "@/components/DashboardLayout";
import { useCredits } from "@/hooks/use-credits";
import { supabase } from "@/lib/supabase";

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = "intent" | "questions" | "generating" | "result";

interface Question {
  id: string;
  label: string;
  placeholder: string;
  required: boolean;
}

interface IntentResult {
  contract_type: string;
  questions: Question[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getAuthHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

// ── Contract section renderer ─────────────────────────────────────────────────

function ContractViewer({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-0.5">
      {lines.map((line, i) => {
        const trimmed = line.trim();

        if (!trimmed) return <div key={i} className="h-3" />;

        // ALL CAPS title lines (e.g. "SERVICE AGREEMENT")
        if (/^[A-Z][A-Z\s\-&,]{6,}$/.test(trimmed)) {
          return (
            <h1 key={i} className="text-[15px] font-bold text-center tracking-wide mt-6 mb-2">
              {trimmed}
            </h1>
          );
        }

        // Numbered section headers (e.g. "1. PAYMENT TERMS" or "1. Payment Terms")
        if (/^\d+\.\s+[A-Z]/.test(trimmed) && trimmed.length < 80) {
          return (
            <h2 key={i} className="text-[13.5px] font-bold mt-5 mb-1.5 text-foreground">
              {trimmed}
            </h2>
          );
        }

        // Sub-clauses (e.g. "1.1" or "a)")
        if (/^(\d+\.\d+|[a-z]\))/.test(trimmed)) {
          return (
            <p key={i} className="text-[12.5px] leading-relaxed pl-5 text-foreground/80">
              {trimmed}
            </p>
          );
        }

        // "This Agreement is made..." style preamble
        if (/^(this agreement|whereas|now, therefore)/i.test(trimmed)) {
          return (
            <p key={i} className="text-[12.5px] leading-relaxed italic text-foreground/70 mt-2">
              {trimmed}
            </p>
          );
        }

        // Signature lines
        if (/^(signed|signature|date:|for and on behalf|authorized signatory)/i.test(trimmed)) {
          return (
            <p key={i} className="text-[12.5px] leading-relaxed font-medium text-foreground/80 mt-1">
              {trimmed}
            </p>
          );
        }

        // Default body text
        return (
          <p key={i} className="text-[12.5px] leading-relaxed text-foreground/75">
            {trimmed}
          </p>
        );
      })}
    </div>
  );
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        navigator.clipboard.writeText(text)
          .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })
          .catch(() => {})
      }
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
    >
      {copied ? <ClipboardCheck className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ── Step indicator ────────────────────────────────────────────────────────────

const STEPS = [
  { key: "intent",     label: "Describe" },
  { key: "questions",  label: "Details"  },
  { key: "result",     label: "Contract" },
];

function StepBar({ current }: { current: Step }) {
  const idx = current === "generating" ? 2 : STEPS.findIndex(s => s.key === current);
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((s, i) => {
        const done    = i < idx;
        const active  = i === idx;
        return (
          <div key={s.key} className="flex items-center">
            <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold transition-colors ${
              done   ? "bg-primary/10 text-primary" :
              active ? "bg-primary text-white" :
                       "bg-muted/60 text-muted-foreground"
            }`}>
              {done
                ? <CheckCircle2 className="h-3 w-3" />
                : <span className="h-3.5 w-3.5 rounded-full border-[1.5px] border-current flex items-center justify-center text-[9px]">{i + 1}</span>
              }
              {s.label}
            </div>
            {i < STEPS.length - 1 && (
              <div className={`h-px w-6 mx-1 ${i < idx ? "bg-primary/40" : "bg-border"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main content ──────────────────────────────────────────────────────────────

function CreateContractContent() {
  const credits  = useCredits();
  const [, setLocation] = useLocation();

  const isPro = credits.plan_id !== "free";

  const [step,         setStep]         = useState<Step>("intent");
  const [description,  setDescription]  = useState("");
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const [answers,      setAnswers]      = useState<Record<string, string>>({});
  const [contractText, setContractText] = useState<string | null>(null);
  const [loadingStep,  setLoadingStep]  = useState<"intent" | "generate" | null>(null);
  const [error,        setError]        = useState<string | null>(null);

  // ── Pro gate ────────────────────────────────────────────────────────────────
  if (!isPro) {
    return (
      <div className="w-full max-w-[960px] mx-auto flex flex-col items-center justify-center py-24 px-4 text-center gap-5">
        <div className="h-16 w-16 rounded-2xl bg-primary/8 border border-primary/15 flex items-center justify-center">
          <Lock className="h-7 w-7 text-primary/50" />
        </div>
        <div>
          <h2 className="text-[16px] font-semibold">Pro Feature</h2>
          <p className="text-[13px] text-muted-foreground mt-1.5 max-w-xs">
            AI-powered contract creation is available on Starter and above. Upgrade to generate legally structured contracts in minutes.
          </p>
        </div>
        <Button size="sm" onClick={() => setLocation("/billing")}>
          View Plans <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  // ── Step 1 → 2: parse intent ─────────────────────────────────────────────
  async function handleAnalyze() {
    if (!description.trim()) {
      setError("Please describe the contract you need.");
      return;
    }
    setError(null);
    setLoadingStep("intent");
    try {
      const headers = await getAuthHeader();
      const res = await fetch("/api/parse-contract-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ description: description.trim() }),
      });
      const json = await res.json() as IntentResult & { error?: string };
      if (!res.ok || !json.contract_type) {
        setError(json.error ?? "Failed to analyze your description. Please try again.");
      } else {
        setIntentResult(json);
        setAnswers({});
        setContractText(null);
        setStep("questions");
      }
    } catch {
      setError("Network error. Please check your connection.");
    } finally {
      setLoadingStep(null);
    }
  }

  // ── Step 2 → 3: generate contract ────────────────────────────────────────
  async function handleGenerate() {
    if (!intentResult) return;

    // Validate required fields
    const missing = intentResult.questions
      .filter(q => q.required && !answers[q.id]?.trim())
      .map(q => q.label);
    if (missing.length > 0) {
      setError(`Please fill in: ${missing[0]}`);
      return;
    }

    setError(null);
    setStep("generating");
    try {
      const headers = await getAuthHeader();
      const res = await fetch("/api/generate-contract", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          type: intentResult.contract_type,
          description: description.trim(),
          answers,
        }),
      });
      const json = await res.json() as { contract_text?: string; error?: string };
      if (!res.ok || !json.contract_text) {
        setError(json.error ?? "Failed to generate contract. Please try again.");
        setStep("questions");
      } else {
        setContractText(json.contract_text);
        setStep("result");
      }
    } catch {
      setError("Network error. Please check your connection.");
      setStep("questions");
    }
  }

  function handleRegenerate() {
    setContractText(null);
    setStep("questions");
  }

  function downloadContract() {
    if (!contractText || !intentResult) return;
    const blob = new Blob([contractText], { type: "text/plain;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${intentResult.contract_type.toLowerCase().replace(/\s+/g, "_")}_${(answers.party_a ?? "party_a").replace(/\s+/g, "_")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const inputBase  = "w-full rounded-lg border border-border/60 bg-white px-3 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-colors";
  const labelBase  = "block text-[11px] font-semibold uppercase tracking-widest text-foreground/50 mb-1.5";

  return (
    <div className="w-full max-w-[960px] mx-auto">

      {/* Step bar */}
      {step !== "generating" && <StepBar current={step} />}

      <AnimatePresence mode="wait">

        {/* ── Step 1: Describe ─────────────────────────────────────────────── */}
        {step === "intent" && (
          <motion.div key="intent" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}
            className="max-w-2xl mx-auto">
            <div className="flex items-center gap-2 mb-1">
              <FileSignature className="h-4 w-4 text-primary/60" />
              <h1 className="text-[15px] font-semibold">Create a Contract</h1>
              <span className="ml-auto text-[10px] font-semibold text-primary/70 bg-primary/8 px-1.5 py-0.5 rounded-full border border-primary/15">Pro</span>
            </div>
            <p className="text-[13px] text-muted-foreground mb-6">
              Describe what you need and we'll ask the right questions to draft a complete, legally structured contract.
            </p>

            <div className="rounded-xl border border-border bg-white p-5 space-y-4">
              <div>
                <label className={labelBase}>Describe your contract</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAnalyze(); }}
                  placeholder="Describe the contract you want to create...&#10;&#10;e.g. I need a service agreement between my software company and a client for a 6-month web development project worth ₹3 lakhs."
                  rows={6}
                  className={`${inputBase} resize-none`}
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground/60 mt-1.5">Tip: Include contract type, parties, purpose, and key terms for best results. Press Ctrl+Enter to continue.</p>
              </div>

              {error && (
                <p className="text-[12px] text-red-500 rounded-lg bg-red-50 border border-red-100 px-3 py-2">{error}</p>
              )}

              <Button onClick={handleAnalyze} disabled={loadingStep === "intent"} className="w-full gap-2">
                {loadingStep === "intent"
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Analyzing…</>
                  : <>Continue <ArrowRight className="h-3.5 w-3.5" /></>
                }
              </Button>
            </div>
          </motion.div>
        )}

        {/* ── Step 2: Questions ────────────────────────────────────────────── */}
        {step === "questions" && intentResult && (
          <motion.div key="questions" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}
            className="max-w-2xl mx-auto">

            {/* Context strip */}
            <div className="flex items-start gap-3 mb-6 p-3.5 rounded-xl bg-primary/4 border border-primary/12">
              <div className="shrink-0 mt-0.5">
                <span className="text-[10px] font-semibold text-primary/70 bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                  {intentResult.contract_type}
                </span>
              </div>
              <p className="text-[12px] text-muted-foreground leading-relaxed flex-1 line-clamp-2">{description}</p>
              <button
                onClick={() => { setStep("intent"); setError(null); }}
                className="shrink-0 text-[11px] text-primary/60 hover:text-primary underline"
              >
                Edit
              </button>
            </div>

            <div className="rounded-xl border border-border bg-white p-5 space-y-4">
              <div>
                <h2 className="text-[13px] font-semibold mb-0.5">Fill in the details</h2>
                <p className="text-[12px] text-muted-foreground">Answer a few questions to personalise your contract.</p>
              </div>

              {intentResult.questions.map((q) => (
                <div key={q.id}>
                  <label className={labelBase}>
                    {q.label}
                    {q.required && <span className="text-red-400 ml-0.5 normal-case tracking-normal font-normal">*</span>}
                  </label>
                  <input
                    type="text"
                    value={answers[q.id] ?? ""}
                    onChange={(e) => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder={q.placeholder}
                    className={inputBase}
                  />
                </div>
              ))}

              {error && (
                <p className="text-[12px] text-red-500 rounded-lg bg-red-50 border border-red-100 px-3 py-2">{error}</p>
              )}

              <div className="flex gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => { setStep("intent"); setError(null); }} className="gap-1.5">
                  <ArrowLeft className="h-3.5 w-3.5" /> Back
                </Button>
                <Button onClick={handleGenerate} className="flex-1 gap-2">
                  <FileSignature className="h-3.5 w-3.5" /> Generate Contract
                </Button>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Generating ───────────────────────────────────────────────────── */}
        {step === "generating" && (
          <motion.div key="generating" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
            className="flex flex-col items-center justify-center py-32 gap-4 text-center">
            <div className="h-14 w-14 rounded-2xl bg-primary/8 border border-primary/15 flex items-center justify-center">
              <Loader2 className="h-7 w-7 text-primary/60 animate-spin" />
            </div>
            <div>
              <p className="text-[14px] font-semibold">Drafting your contract…</p>
              <p className="text-[12px] text-muted-foreground mt-1">This may take up to 30 seconds</p>
            </div>
            {intentResult && (
              <span className="text-[11px] text-primary/60 bg-primary/6 border border-primary/15 px-3 py-1 rounded-full">
                {intentResult.contract_type}
              </span>
            )}
          </motion.div>
        )}

        {/* ── Step 3: Result ───────────────────────────────────────────────── */}
        {step === "result" && contractText && intentResult && (
          <motion.div key="result" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>

            {/* Result header */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-semibold text-primary/70 bg-primary/8 px-2 py-0.5 rounded-full border border-primary/15">
                    {intentResult.contract_type}
                  </span>
                  {answers.party_a && answers.party_b && (
                    <span className="text-[12px] text-muted-foreground truncate">
                      {answers.party_a} &amp; {answers.party_b}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground/60 mt-1">
                  AI-generated based on Indian contract law. Not legal advice — consult a lawyer before signing.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <CopyBtn text={contractText} />
                <button
                  onClick={downloadContract}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                >
                  <Download className="h-3.5 w-3.5" /> Download
                </button>
                <button
                  onClick={handleRegenerate}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Regenerate
                </button>
              </div>
            </div>

            {/* Contract viewer */}
            <div className="rounded-xl border border-border/60 bg-white shadow-[0_1px_6px_rgba(0,0,0,0.04)] p-6 md:p-10">
              <ContractViewer text={contractText} />
            </div>

            {/* Bottom actions */}
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-border/40">
              <button
                onClick={() => { setStep("intent"); setContractText(null); setDescription(""); setAnswers({}); setIntentResult(null); setError(null); }}
                className="text-[12px] text-muted-foreground hover:text-foreground underline"
              >
                Start over
              </button>
              <div className="flex items-center gap-2">
                <CopyBtn text={contractText} />
                <button
                  onClick={downloadContract}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                >
                  <Download className="h-3.5 w-3.5" /> Download .txt
                </button>
              </div>
            </div>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}

// ── Page wrapper ──────────────────────────────────────────────────────────────

export default function CreateContractPage() {
  return (
    <DashboardLayout>
      <CreateContractContent />
    </DashboardLayout>
  );
}
