import { useState } from "react";
import { useLocation } from "wouter";
import { FileSignature, Download, Copy, ClipboardCheck, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardLayout } from "@/components/DashboardLayout";
import { useCredits } from "@/hooks/use-credits";
import { supabase } from "@/lib/supabase";

// ── Contract type definitions ─────────────────────────────────────────────────

type ContractType = {
  value: string;
  label: string;
  extraFields: { key: string; label: string; placeholder: string; required?: boolean }[];
};

const CONTRACT_TYPES: ContractType[] = [
  {
    value: "Service Agreement",
    label: "Service Agreement",
    extraFields: [
      { key: "scope", label: "Scope of Services", placeholder: "Describe the services to be provided", required: true },
      { key: "payment_amount", label: "Payment Amount (₹)", placeholder: "e.g. ₹50,000" },
      { key: "payment_schedule", label: "Payment Schedule", placeholder: "e.g. 50% upfront, 50% on delivery" },
      { key: "duration", label: "Contract Duration", placeholder: "e.g. 6 months" },
    ],
  },
  {
    value: "Non-Disclosure Agreement",
    label: "Non-Disclosure Agreement (NDA)",
    extraFields: [
      { key: "confidential_info", label: "Nature of Confidential Information", placeholder: "e.g. business plans, trade secrets, source code" },
      { key: "duration", label: "NDA Duration", placeholder: "e.g. 2 years" },
      { key: "purpose", label: "Purpose of Disclosure", placeholder: "e.g. evaluating a potential partnership" },
    ],
  },
  {
    value: "Rental Agreement",
    label: "Rental Agreement",
    extraFields: [
      { key: "property_address", label: "Property Address", placeholder: "Full address of the property", required: true },
      { key: "rent_amount", label: "Monthly Rent (₹)", placeholder: "e.g. ₹25,000", required: true },
      { key: "duration", label: "Lease Duration", placeholder: "e.g. 11 months", required: true },
      { key: "security_deposit", label: "Security Deposit (₹)", placeholder: "e.g. ₹50,000" },
    ],
  },
  {
    value: "Employment Agreement",
    label: "Employment Agreement",
    extraFields: [
      { key: "designation", label: "Job Title / Designation", placeholder: "e.g. Senior Software Engineer", required: true },
      { key: "salary", label: "Monthly Salary (₹)", placeholder: "e.g. ₹1,20,000", required: true },
      { key: "start_date", label: "Start Date", placeholder: "e.g. 1 April 2026" },
      { key: "notice_period", label: "Notice Period", placeholder: "e.g. 30 days" },
      { key: "probation", label: "Probation Period", placeholder: "e.g. 3 months" },
    ],
  },
  {
    value: "Freelancer Agreement",
    label: "Freelancer Agreement",
    extraFields: [
      { key: "deliverables", label: "Deliverables", placeholder: "Describe what the freelancer will deliver", required: true },
      { key: "project_fee", label: "Project Fee (₹)", placeholder: "e.g. ₹80,000" },
      { key: "payment_schedule", label: "Payment Schedule", placeholder: "e.g. milestone-based" },
      { key: "timeline", label: "Project Timeline", placeholder: "e.g. 8 weeks" },
    ],
  },
];

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {})}
      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      title="Copy contract"
    >
      {copied ? <ClipboardCheck className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function CreateContractContent() {
  const credits = useCredits();
  const [, setLocation] = useLocation();

  const isPro = credits.plan_id !== "free";

  const [selectedType, setSelectedType] = useState<ContractType>(CONTRACT_TYPES[0]);
  const [partyA, setPartyA] = useState("");
  const [partyB, setPartyB] = useState("");
  const [description, setDescription] = useState("");
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contractText, setContractText] = useState<string | null>(null);

  function handleTypeChange(value: string) {
    const t = CONTRACT_TYPES.find((c) => c.value === value) ?? CONTRACT_TYPES[0];
    setSelectedType(t);
    setExtraValues({});
    setContractText(null);
    setError(null);
  }

  function downloadContract() {
    if (!contractText) return;
    const blob = new Blob([contractText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedType.value.toLowerCase().replace(/\s+/g, "_")}_${partyA.replace(/\s+/g, "_")}_${partyB.replace(/\s+/g, "_")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleGenerate() {
    if (!partyA.trim() || !partyB.trim() || !description.trim()) {
      setError("Party A, Party B, and Description are required.");
      return;
    }
    setLoading(true);
    setError(null);
    setContractText(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/generate-contract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          type: selectedType.value,
          partyA: partyA.trim(),
          partyB: partyB.trim(),
          description: description.trim(),
          extra_fields: extraValues,
        }),
      });
      const json = await res.json() as { contract_text?: string; error?: string };
      if (!res.ok || !json.contract_text) {
        setError(json.error ?? "Failed to generate contract. Please try again.");
      } else {
        setContractText(json.contract_text);
      }
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  // ── Upgrade gate ──────────────────────────────────────────────────────────
  if (!isPro) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="h-14 w-14 rounded-2xl bg-primary/8 border border-primary/15 flex items-center justify-center mx-auto">
            <Lock className="h-6 w-6 text-primary/60" />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold">Pro Feature</h2>
            <p className="text-[13px] text-muted-foreground mt-1">
              Create Contract is available on Starter and above plans. Upgrade to generate legally structured contracts instantly.
            </p>
          </div>
          <Button size="sm" onClick={() => setLocation("/billing")} className="w-full">
            View Plans
          </Button>
        </div>
      </div>
    );
  }

  const inputBase = "w-full rounded-lg border border-border/60 bg-white px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-colors";
  const labelBase = "block text-[11px] font-semibold uppercase tracking-widest text-foreground/50 mb-1.5";

  return (
    <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">

      {/* ── Left panel: form ─────────────────────────────────────────────── */}
      <div className="w-full md:w-[360px] md:max-w-[360px] shrink-0 flex flex-col border-r border-border/40 bg-white overflow-y-auto">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border/40">
          <div className="flex items-center gap-2">
            <FileSignature className="h-4 w-4 text-primary/60" />
            <h1 className="text-[14px] font-semibold">Create Contract</h1>
            <span className="ml-auto text-[10px] font-semibold text-primary/70 bg-primary/8 px-1.5 py-0.5 rounded-full border border-primary/15">Pro</span>
          </div>
          <p className="text-[12px] text-muted-foreground mt-1">Generate a complete, legally structured contract using AI.</p>
        </div>

        <div className="flex-1 px-4 py-4 space-y-4">
          {/* Contract type */}
          <div>
            <label className={labelBase}>Contract Type</label>
            <select
              value={selectedType.value}
              onChange={(e) => handleTypeChange(e.target.value)}
              className={inputBase}
            >
              {CONTRACT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Party A */}
          <div>
            <label className={labelBase}>Party A (Full Name / Company)</label>
            <input
              type="text"
              value={partyA}
              onChange={(e) => setPartyA(e.target.value)}
              placeholder="e.g. Acme Solutions Pvt. Ltd."
              className={inputBase}
            />
          </div>

          {/* Party B */}
          <div>
            <label className={labelBase}>Party B (Full Name / Company)</label>
            <input
              type="text"
              value={partyB}
              onChange={(e) => setPartyB(e.target.value)}
              placeholder="e.g. Rahul Sharma"
              className={inputBase}
            />
          </div>

          {/* Description */}
          <div>
            <label className={labelBase}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Briefly describe the purpose and context of this contract…"
              rows={3}
              className={`${inputBase} resize-none`}
            />
          </div>

          {/* Dynamic extra fields */}
          {selectedType.extraFields.length > 0 && (
            <div className="space-y-3 pt-1 border-t border-border/30">
              <p className={`${labelBase} pt-1`}>Additional Details</p>
              {selectedType.extraFields.map((f) => (
                <div key={f.key}>
                  <label className={labelBase}>
                    {f.label}{f.required && <span className="text-red-400 ml-0.5">*</span>}
                  </label>
                  <input
                    type="text"
                    value={extraValues[f.key] ?? ""}
                    onChange={(e) => setExtraValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    className={inputBase}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-[12px] text-red-500 rounded-lg bg-red-50 border border-red-100 px-3 py-2">{error}</p>
          )}

          {/* Generate button */}
          <Button
            onClick={handleGenerate}
            disabled={loading}
            className="w-full gap-2"
            size="sm"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSignature className="h-3.5 w-3.5" />}
            {loading ? "Generating…" : "Generate Contract"}
          </Button>

          {contractText && (
            <p className="text-[11px] text-muted-foreground text-center">
              AI-generated based on Indian contract law. Not legal advice.
            </p>
          )}
        </div>
      </div>

      {/* ── Right panel: contract viewer ──────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
        {/* Viewer header */}
        <div className="flex items-center gap-3 px-4 md:px-5 h-12 md:h-[53px] border-b border-border/40 bg-white/90 backdrop-blur-sm shrink-0">
          <FileSignature className="h-4 w-4 text-muted-foreground/50 shrink-0" />
          <span className="text-[12px] text-muted-foreground truncate flex-1">
            {contractText ? `${selectedType.label} — ${partyA} & ${partyB}` : "Contract Preview"}
          </span>
          {contractText && (
            <div className="flex items-center gap-3 ml-auto shrink-0">
              <CopyBtn text={contractText} />
              <button
                onClick={downloadContract}
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </button>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 md:p-6">
          {!contractText && !loading && (
            <div className="h-full flex flex-col items-center justify-center gap-4 text-center select-none">
              <div className="h-16 w-16 rounded-2xl bg-muted/60 flex items-center justify-center">
                <FileSignature className="h-8 w-8 text-muted-foreground/30" />
              </div>
              <div>
                <p className="text-[13px] font-medium text-muted-foreground">No contract generated yet</p>
                <p className="text-[12px] text-muted-foreground/60 mt-1">Fill in the form and click Generate Contract</p>
              </div>
            </div>
          )}

          {loading && (
            <div className="h-full flex flex-col items-center justify-center gap-3 select-none">
              <Loader2 className="h-8 w-8 text-primary/40 animate-spin" />
              <p className="text-[13px] text-muted-foreground">Drafting your contract…</p>
              <p className="text-[11px] text-muted-foreground/60">This may take up to 30 seconds</p>
            </div>
          )}

          {contractText && !loading && (
            <div className="max-w-3xl mx-auto">
              <div className="rounded-xl border border-border/60 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.04)] p-6 md:p-8">
                <pre className="text-[12.5px] text-foreground/80 leading-relaxed whitespace-pre-wrap font-mono">
                  {contractText}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CreateContractPage() {
  return (
    <DashboardLayout>
      <CreateContractContent />
    </DashboardLayout>
  );
}
