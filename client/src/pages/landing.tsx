import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence, useInView } from "framer-motion";
import { useLocation, Link } from "wouter";
import {
  Shield, FileSearch, ChevronRight, Check, AlertTriangle,
  ArrowRight, X, Sparkles, BookOpen, Gavel, Lock, Lightbulb, Scale,
  Info, Mail, Rocket, Briefcase, Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/Logo";
import { RiskBar } from "@/components/RiskBar";
import { demoContractText, mockClauses, demoSteps } from "@/lib/mock-data";
import { useAuth } from "@/context/auth-context";

const fadeUp = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.08 } } };

/* ── Navbar ─────────────────────────────────────── */
function Navbar({ onLogin }: { onLogin: () => void }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", fn);
    return () => window.removeEventListener("scroll", fn);
  }, []);
  const scrollTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#0a1e3d] border-b border-white/[0.06] shadow-lg">
      <div className="max-w-[1140px] mx-auto flex items-center justify-between px-6 h-14">
        <div className="flex items-center gap-2">
          <Logo size={24} dark />
          <span className="text-sm font-semibold tracking-tight text-white">
            clausemate<span className="text-sky-300">.ai</span>
          </span>
        </div>
        <div className="hidden md:flex items-center gap-8">
          {[
            ["Who is this for", "who-is-this-for"],
            ["Features", "features"],
            ["Platform", "demo"],
            ["Pricing", "pricing"],
          ].map(([label, id]) => (
            <button key={id} onClick={() => scrollTo(id)} className="text-[13px] text-white/70 hover:text-white transition-colors">{label}</button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onLogin} className="text-[13px] text-white hover:bg-white/10" data-testid="nav-login-btn">Sign In</Button>
          <Button size="sm" onClick={onLogin} className="text-[13px] px-5 bg-white text-[#0a1e3d] hover:bg-white/90" data-testid="nav-try-free-btn">Get Started</Button>
        </div>
      </div>
    </nav>
  );
}

/* ── Hero — full animated gradient background, no box behind title ── */
function HeroSection({ onTryFree }: { onTryFree: () => void }) {
  return (
    <section className="hero-gradient-light min-h-screen flex items-center px-4 sm:px-6">
      <div className="max-w-[700px] mx-auto text-center">
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}
          className="text-[10px] sm:text-xs uppercase tracking-[0.18em] text-white/70 font-medium mb-4 sm:mb-6">
          AI-Powered Contract Intelligence
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.05 }}
          className="font-display text-[1.8rem] sm:text-[2.4rem] md:text-[3rem] leading-[1.1] mb-4 sm:mb-6 text-white"
        >
          Protect your interests <br />
          by investing in{" "}
          <span className="text-sky-300">professional review</span>
        </motion.h1>

        <motion.p initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.12 }}
          className="text-[13px] sm:text-[15px] text-white/60 leading-relaxed max-w-[480px] mx-auto mb-6 sm:mb-9 px-2 sm:px-0">
          Gain clarity, reduce risk, and make confident decisions with AI-powered contract analysis built for Indian law.
        </motion.p>

        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.2 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Button size="lg" onClick={onTryFree} className="w-full sm:w-auto px-7 h-11 text-[13px] bg-white text-[#0a3d6e] hover:bg-white/90" data-testid="hero-try-free-btn">
            Get Started <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
          <Button variant="outline" size="lg" onClick={() => document.getElementById("demo")?.scrollIntoView({ behavior: "smooth" })}
            className="w-full sm:w-auto px-7 h-11 text-[13px] border-white/30 text-white hover:bg-white/10" data-testid="hero-see-demo-btn">
            View Platform
          </Button>
        </motion.div>
      </div>
    </section>
  );
}

/* ── Who Is This For — dark card design adapted from reference ── */

/* Line-art SVG icons matching the reference's geometric style */
function IconCircleOrbit() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="18" cy="18" r="8" />
      <ellipse cx="18" cy="18" rx="16" ry="6" transform="rotate(-30 18 18)" strokeOpacity="0.4" />
    </svg>
  );
}
function IconShieldScan() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M18 4l12 5v9c0 7-5.5 12-12 14C11.5 30 6 25 6 18V9l12-5z" strokeOpacity="0.5" />
      <circle cx="18" cy="17" r="5" />
      <path d="M18 12v10M13 17h10" strokeOpacity="0.3" />
    </svg>
  );
}
function IconStackLayers() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="1.2">
      <ellipse cx="18" cy="14" rx="12" ry="5" />
      <ellipse cx="18" cy="20" rx="12" ry="5" strokeOpacity="0.5" />
      <ellipse cx="18" cy="26" rx="12" ry="5" strokeOpacity="0.25" />
    </svg>
  );
}

const audiences = [
  {
    icon: IconCircleOrbit,
    titleLine1: "STARTUPS &",
    titleLine2: "FOUNDERS",
    desc: "Independent answers to complex investor agreements, SAFEs, and co-founder contracts. Understand every clause before you sign.",
  },
  {
    icon: IconShieldScan,
    titleLine1: "FREELANCERS &",
    titleLine2: "CONSULTANTS",
    desc: "Protect your IP, avoid unfair termination and non-compete clauses. Get clarity on liability and payment terms.",
  },
  {
    icon: IconStackLayers,
    titleLine1: "ENTERPRISES &",
    titleLine2: "MSMEs",
    desc: "Review vendor, supplier, and service contracts for hidden payment risks. Ensure MSME Act compliance on every deal.",
  },
];

function WhoIsThisForSection() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  const cardColors = [
    { icon: "text-blue-600", bg: "bg-blue-50", border: "hover:border-blue-200" },
    { icon: "text-sky-600", bg: "bg-sky-50", border: "hover:border-sky-200" },
    { icon: "text-indigo-600", bg: "bg-indigo-50", border: "hover:border-indigo-200" },
  ];

  return (
    <section id="who-is-this-for" className="py-16 sm:py-24 px-4 sm:px-6" ref={ref}>
      <div className="max-w-[1000px] mx-auto">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={isInView ? { opacity: 1, y: 0 } : {}} className="text-center mb-12">
          <p className="text-xs uppercase tracking-[0.18em] text-primary font-medium mb-3">Who is this for</p>
          <h2 className="font-display text-2xl md:text-3xl">Contract clarity for everyone</h2>
        </motion.div>

        <motion.div variants={stagger} initial="hidden" animate={isInView ? "show" : "hidden"} className="grid md:grid-cols-3 gap-5">
          {audiences.map((a, i) => (
            <motion.div
              key={a.titleLine2}
              variants={fadeUp}
              transition={{ duration: 0.4 }}
              className={`group rounded-xl border border-border bg-white p-7 pb-12 relative transition-all duration-200 ${cardColors[i].border} hover:shadow-md cursor-default`}
            >
              <div className={`h-10 w-10 rounded-lg ${cardColors[i].bg} flex items-center justify-center mb-5`}>
                <div className={cardColors[i].icon}><a.icon /></div>
              </div>
              <h3 className="text-[14px] font-bold tracking-wide mb-3 text-foreground">
                {a.titleLine1} {a.titleLine2}
              </h3>
              <p className="text-[12px] text-muted-foreground leading-relaxed">{a.desc}</p>
              <div className="absolute bottom-4 right-4 text-muted-foreground/20 group-hover:text-primary/40 transition-colors">
                <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 13L13 5M13 5H6M13 5v7" /></svg>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ── Mission / Watermark ─────────────────────────── */
function MissionSection() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });
  return (
    <section ref={ref} className="py-24 px-6 text-center overflow-hidden relative">
      <motion.p initial={{ opacity: 0, y: 12 }} animate={isInView ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.5 }}
        className="max-w-[560px] mx-auto text-lg md:text-xl text-foreground/80 leading-relaxed relative z-10">
        Our mission is to help businesses and professionals understand their contracts with{" "}
        <span className="text-foreground font-medium">AI-powered analysis and clear, actionable insights</span>{" "}
        — so they can sign with confidence.
      </motion.p>
      <div className="watermark absolute inset-x-0 bottom-[-0.15em] text-center z-0 select-none" aria-hidden>clausemate</div>
    </section>
  );
}

/* ── Live Demo (Fix #5: contract headings highlighted black) ── */
function LiveDemoSection() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });
  const [phase, setPhase] = useState<"idle" | "analyzing" | "results">("idle");
  const [currentStep, setCurrentStep] = useState(0);
  const [typedText, setTypedText] = useState("");
  const [visibleClauses, setVisibleClauses] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const startDemo = useCallback(() => {
    setPhase("analyzing"); setCurrentStep(0); setTypedText(""); setVisibleClauses(0);
    let step = 0;
    const si = setInterval(() => {
      step++;
      if (step >= demoSteps.length) {
        clearInterval(si);
        setTimeout(() => {
          setPhase("results");
          let c = 0;
          const ci = setInterval(() => { c++; setVisibleClauses(c); if (c >= 3) clearInterval(ci); }, 500);
          const exp = mockClauses[0].explanation;
          let idx = 0;
          const ti = setInterval(() => { idx++; setTypedText(exp.slice(0, idx)); if (idx >= exp.length) clearInterval(ti); }, 14);
        }, 300);
      } else setCurrentStep(step);
    }, 600);
  }, []);

  useEffect(() => {
    if (!isInView) return;
    const run = () => {
      startDemo();
      timerRef.current = setTimeout(() => { setPhase("idle"); setTimeout(run, 2500); }, 20000);
    };
    const id = setTimeout(run, 600);
    return () => { clearTimeout(id); if (timerRef.current) clearTimeout(timerRef.current); };
  }, [isInView, startDemo]);

  /* Render contract text with section headings in black */
  const renderContractLine = (line: string, i: number) => {
    const isRiskyHighlight = phase === "results" && (
      line.includes("Late payments shall not accrue") ||
      line.includes("whether or not in the course") ||
      line.includes("period of 24 months")
    );
    /* Match lines like "1. SCOPE OF SERVICES", "CONSULTING SERVICES AGREEMENT", etc. */
    const isSectionHeading = /^(CONSULTING SERVICES AGREEMENT|\d+\.\s+[A-Z][A-Z\s&]+)$/.test(line.trim());

    if (isRiskyHighlight) {
      return <span key={i} className="bg-red-50 border-l-2 border-red-400 pl-2 -ml-2 block my-0.5">{line}{"\n"}</span>;
    }
    if (isSectionHeading) {
      return <span key={i} className="text-foreground font-semibold block mt-2">{line}{"\n"}</span>;
    }
    return <span key={i}>{line}{"\n"}</span>;
  };

  return (
    <section id="demo" className="py-16 sm:py-28 px-4 sm:px-6" ref={ref}>
      <div className="max-w-[1140px] mx-auto">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={isInView ? { opacity: 1, y: 0 } : {}} className="text-center mb-14">
          <p className="text-xs uppercase tracking-[0.18em] text-primary font-medium mb-3">Platform</p>
          <h2 className="font-display text-2xl md:text-3xl mb-3">Intelligent contract analysis in action</h2>
          <p className="text-sm text-muted-foreground max-w-[440px] mx-auto">
            See how clausemate.ai examines a consulting agreement, flags risks, and recommends protective language.
          </p>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 18 }} animate={isInView ? { opacity: 1, y: 0 } : {}} transition={{ delay: 0.1, duration: 0.5 }}
          className="grid lg:grid-cols-2 gap-0 rounded-xl border border-border bg-card overflow-hidden shadow-md">

          {/* Left: Contract — headings now rendered in black */}
          <div className="p-6 max-h-[520px] overflow-y-auto border-r border-border/60">
            <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/40">
              <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Source Document</span>
            </div>
            <div className="text-[11px] leading-[1.75] text-muted-foreground whitespace-pre-wrap font-mono">
              {demoContractText.split("\n").map(renderContractLine)}
            </div>
          </div>

          {/* Right: Analysis */}
          <div className="p-6 max-h-[520px] overflow-y-auto bg-white">
            <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border/40">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span className="text-[11px] uppercase tracking-[0.12em] text-primary font-medium">AI Analysis</span>
            </div>

            <AnimatePresence mode="wait">
              {phase === "idle" && (
                <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center justify-center h-64 gap-3">
                  <Scale className="h-7 w-7 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground/50">Initializing analysis...</p>
                </motion.div>
              )}
              {phase === "analyzing" && (
                <motion.div key="analyzing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
                  <div className="rounded-lg bg-muted/30 p-4"><div className="space-y-2.5"><div className="h-3 w-3/4 rounded shimmer" /><div className="h-3 w-1/2 rounded shimmer" /><div className="h-3 w-2/3 rounded shimmer" /></div></div>
                  <div className="space-y-2 mt-4">
                    {demoSteps.map((step, i) => (
                      <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: i <= currentStep ? 1 : 0.2, x: 0 }} transition={{ delay: i * 0.06 }} className="flex items-center gap-2.5">
                        {i < currentStep ? <Check className="h-3 w-3 text-primary shrink-0" /> : i === currentStep ? <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }} className="h-3 w-3 rounded-full border border-primary border-t-transparent shrink-0" /> : <div className="h-3 w-3 rounded-full border border-border/40 shrink-0" />}
                        <span className={`text-[11px] ${i <= currentStep ? "text-foreground/80" : "text-muted-foreground/30"}`}>{step}</span>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              )}
              {phase === "results" && (
                <motion.div key="results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
                  <div className="mb-3"><RiskBar score={72} /></div>
                  <div className="space-y-2">
                    {mockClauses.slice(0, 3).map((cl, i) => (
                      <motion.div key={cl.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: i < visibleClauses ? 1 : 0, y: i < visibleClauses ? 0 : 6 }}
                        className={`rounded-lg p-3 border ${cl.riskLevel === "high" ? "risk-high-bg" : cl.riskLevel === "medium" ? "risk-medium-bg" : "risk-low-bg"}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <AlertTriangle className={`h-3 w-3 risk-${cl.riskLevel}`} />
                          <span className="text-[11px] font-semibold text-red-600">{cl.title}</span>
                          <span className={`ml-auto text-[9px] font-semibold uppercase tracking-wider risk-${cl.riskLevel}`}>{cl.riskLevel}</span>
                        </div>
                        <p className="text-[10px] text-foreground/80 line-clamp-2">{cl.text}</p>
                      </motion.div>
                    ))}
                  </div>
                  {typedText && (
                    <div className="rounded-lg bg-muted/30 p-3 border border-border/40">
                      <p className="text-[10px] uppercase tracking-[0.1em] font-medium text-primary mb-1.5">Counsel Note</p>
                      <p className="text-[11px] text-foreground/80 leading-relaxed">{typedText}{typedText.length < mockClauses[0].explanation.length && <span className="typing-cursor" />}</p>
                    </div>
                  )}
                  {visibleClauses >= 3 && (
                    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="rounded-lg bg-primary/[0.04] border border-primary/10 p-3">
                      <p className="text-[10px] uppercase tracking-[0.1em] font-medium text-primary mb-1.5">Recommended Revision</p>
                      <p className="text-[11px] text-foreground/80 leading-relaxed">{mockClauses[0].suggestedRewrite}</p>
                    </motion.div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* ── Features ────────────────────────────────────── */
const features = [
  { icon: Shield, color: "text-rose-500", bg: "bg-rose-50", title: "Risk Detection", desc: "Identify high-risk clauses that expose you to liability. Every clause scored against Indian legal standards." },
  { icon: FileSearch, color: "text-indigo-500", bg: "bg-indigo-50", title: "Clause Analysis", desc: "Plain-language breakdown of every provision. No legal jargon — clear explanations your team can act on." },
  { icon: Gavel, color: "text-amber-600", bg: "bg-amber-50", title: "Revision Drafting", desc: "AI-generated protective language aligned with Indian Contract Act, MSME Act, and current judicial precedent." },
  { icon: Lightbulb, color: "text-emerald-600", bg: "bg-emerald-50", title: "Smart Clause Suggestions", desc: "Get AI-suggested improvements to strengthen risky or unclear clauses." },
];

function FeaturesSection() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });
  return (
    <section id="features" className="py-16 sm:py-28 px-4 sm:px-6 bg-card/50" ref={ref}>
      <div className="max-w-[1140px] mx-auto">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={isInView ? { opacity: 1, y: 0 } : {}} className="text-center mb-16">
          <p className="text-xs uppercase tracking-[0.18em] text-primary font-medium mb-3">Capabilities</p>
          <h2 className="font-display text-2xl md:text-3xl mb-3">Built for Indian legal practice</h2>
          <p className="text-sm text-muted-foreground max-w-[440px] mx-auto">From in-house counsel to boutique firms, clausemate.ai brings institutional-grade contract intelligence to every review.</p>
        </motion.div>
        <motion.div variants={stagger} initial="hidden" animate={isInView ? "show" : "hidden"} className="grid sm:grid-cols-2 gap-5">
          {features.map((f) => (
            <motion.div key={f.title} variants={fadeUp} transition={{ duration: 0.4 }}
              className="rounded-xl border border-border bg-white p-7 hover:border-primary/20 transition-colors duration-200">
              <div className={`h-9 w-9 rounded-lg ${f.bg} flex items-center justify-center mb-4`}>
                <f.icon className={`h-[18px] w-[18px] ${f.color}`} />
              </div>
              <h3 className="text-sm font-semibold mb-2">{f.title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ── Pricing (credit-based) ───────────────────────── */
import { PLANS, formatPrice } from "@/lib/credits";

function PricingSection({ onSelectPlan }: { onSelectPlan: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });
  return (
    <section id="pricing" className="py-16 sm:py-28 px-4 sm:px-6" ref={ref}>
      <div className="max-w-[1100px] mx-auto">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={isInView ? { opacity: 1, y: 0 } : {}} className="text-center mb-16">
          <p className="text-xs uppercase tracking-[0.18em] text-primary font-medium mb-3">Pricing</p>
          <h2 className="font-display text-2xl md:text-3xl mb-3">Credit-based pricing that scales with you</h2>
          <p className="text-sm text-muted-foreground max-w-[440px] mx-auto">Pay for what you use. 1 contract analysis = 8–12 credits. Redlines and rewrites cost extra.</p>
        </motion.div>
        <motion.div variants={stagger} initial="hidden" animate={isInView ? "show" : "hidden"} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {PLANS.map((plan) => (
            <motion.div key={plan.id} variants={fadeUp} transition={{ duration: 0.4 }}
              className={`relative rounded-xl border p-6 bg-white flex flex-col ${plan.popular ? "border-primary shadow-md" : "border-border"}`}>
              {plan.popular && <div className="absolute -top-3 left-1/2 -translate-x-1/2"><span className="text-[10px] uppercase tracking-wider font-semibold text-white bg-primary px-3 py-1 rounded-full">Recommended</span></div>}
              <h3 className="text-sm font-semibold mb-0.5">{plan.name}</h3>
              <div className="flex items-baseline gap-1 mb-1 mt-3"><span className="font-display text-2xl">{formatPrice(plan.monthly_price)}</span>{plan.monthly_price > 0 && <span className="text-xs text-muted-foreground">/mo</span>}</div>
              <p className="text-[11px] text-primary font-medium mb-4">{plan.credits} credits/month</p>
              <ul className="space-y-2 mb-6 flex-1">
                {plan.features.map((f) => (<li key={f} className="flex items-start gap-2"><Check className="h-3.5 w-3.5 text-primary/70 shrink-0 mt-0.5" /><span className="text-[12px] text-muted-foreground leading-snug">{f}</span></li>))}
              </ul>
              <Button className="w-full mt-auto" variant={plan.popular ? "default" : "outline"} size="sm" onClick={onSelectPlan} data-testid={`pricing-${plan.id}-btn`}>
                {plan.cta} <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ── AI Disclaimer ───────────────────────────────── */
function DisclaimerSection() {
  return (
    <section className="py-8 sm:py-12 px-4 sm:px-6">
      <div className="max-w-[700px] mx-auto rounded-xl border border-border bg-card/50 p-4 sm:p-6 flex gap-3 sm:gap-4">
        <Info className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground shrink-0 mt-0.5" />
        <div>
          <p className="text-[10px] sm:text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.12em] mb-1">Important Notice</p>
          <p className="text-[11px] sm:text-[12px] text-muted-foreground leading-relaxed">
            clausemate.ai is an AI-powered contract analysis tool and not a legal firm, law practice, or substitute for professional legal advice. All outputs are informational and should be reviewed by a qualified legal professional before making any decisions. We do not provide legal opinions or representation.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ── Login Modal ─────────────────────────────────── */
function LoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmationPending, setConfirmationPending] = useState(false);
  const { login, signup, authError } = useAuth();
  const [, setLocation] = useLocation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (isSignup) {
        const { needsConfirmation } = await signup(email, password);
        if (needsConfirmation) {
          setConfirmationPending(true);
          return;
        }
      } else {
        await login(email, password);
      }
      setLocation("/dashboard");
      onClose();
    } catch { /* authError is set by login/signup and displayed below */ }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 backdrop-blur-sm px-4" onClick={onClose}>
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.25 }} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-xl border border-border bg-white p-8 shadow-xl">
            <div className="flex items-center justify-between mb-7">
              <div className="flex items-center gap-2"><Logo size={22} /><span className="text-sm font-semibold">clausemate<span className="text-primary">.ai</span></span></div>
              <button onClick={onClose} className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-accent transition-colors" data-testid="close-login-modal"><X className="h-3.5 w-3.5" /></button>
            </div>

            {confirmationPending ? (
              <div className="text-center py-4" data-testid="confirmation-pending">
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <svg className="h-6 w-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                </div>
                <h2 className="font-display text-lg mb-2">Check your email</h2>
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  We sent a confirmation link to <span className="font-medium text-foreground">{email}</span>. Click it to activate your account.
                </p>
                <button
                  onClick={() => { setConfirmationPending(false); setIsSignup(false); }}
                  className="mt-6 text-[12px] text-primary hover:underline"
                >
                  Back to sign in
                </button>
              </div>
            ) : (
              <>
                <h2 className="font-display text-lg mb-1">{isSignup ? "Create your account" : "Welcome back"}</h2>
                <p className="text-xs text-muted-foreground mb-6">{isSignup ? "Begin analyzing contracts in seconds." : "Sign in to continue."}</p>
                <Button variant="outline" className="w-full mb-4 h-10" onClick={handleSubmit} data-testid="google-login-btn">
                  <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                  Continue with Google
                </Button>
                <div className="flex items-center gap-3 mb-4"><div className="flex-1 h-px bg-border" /><span className="text-[10px] text-muted-foreground">or</span><div className="flex-1 h-px bg-border" /></div>
                <form onSubmit={handleSubmit} className="space-y-3">
                  <div><label className="text-[11px] font-medium mb-1.5 block text-muted-foreground">Email</label><Input type="email" placeholder="you@firm.in" value={email} onChange={(e) => setEmail(e.target.value)} className="h-10 text-[13px]" data-testid="login-email-input" /></div>
                  <div><label className="text-[11px] font-medium mb-1.5 block text-muted-foreground">Password</label><Input type="password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 text-[13px]" data-testid="login-password-input" /></div>
                  <Button type="submit" className="w-full h-10" data-testid="login-submit-btn">{isSignup ? "Create Account" : "Sign In"}</Button>
                  {authError && <p className="text-[11px] text-destructive pt-1">{authError}</p>}
                </form>
                <p className="text-center text-[11px] text-muted-foreground mt-5">{isSignup ? "Already have an account?" : "Don't have an account?"}{" "}<button onClick={() => setIsSignup(!isSignup)} className="text-primary hover:underline" data-testid="toggle-signup-btn">{isSignup ? "Sign in" : "Sign up"}</button></p>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── Page — new section order ────────────────────── */
export default function LandingPage() {
  const [loginOpen, setLoginOpen] = useState(false);
  return (
    <div className="min-h-screen bg-background">
      <Navbar onLogin={() => setLoginOpen(true)} />
      {/* 1. Hero + CTAs */}
      <HeroSection onTryFree={() => setLoginOpen(true)} />
      {/* 2. Who is this for (was separate page, now inline) */}
      <WhoIsThisForSection />
      {/* 3. Mission */}
      <MissionSection />
      {/* 4. Features */}
      <FeaturesSection />
      {/* 5. Demo */}
      <LiveDemoSection />
      {/* 6. Pricing */}
      <PricingSection onSelectPlan={() => setLoginOpen(true)} />
      <DisclaimerSection />

      <footer className="border-t border-border/50 py-6 px-4 sm:px-6">
        <div className="max-w-[1140px] mx-auto">
          {/* Mobile: stacked. Desktop: single row with absolute-centered middle */}
          <div className="flex flex-col gap-2 items-center text-xs text-muted-foreground md:relative md:flex-row md:items-center md:justify-between md:gap-0">
            {/* LEFT */}
            <div className="flex items-center gap-4">
              <a href="mailto:admin@spacesuite.io" className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                <Mail className="h-3 w-3" /> admin@spacesuite.io
              </a>
              <span className="text-border/70">·</span>
              <Link href="/privacy"><span className="hover:text-foreground cursor-pointer transition-colors">Privacy</span></Link>
              <span className="text-border/70">·</span>
              <Link href="/terms"><span className="hover:text-foreground cursor-pointer transition-colors">Terms</span></Link>
              <span className="text-border/70">·</span>
              <Link href="/security"><span className="hover:text-foreground cursor-pointer transition-colors">Security</span></Link>
            </div>
            {/* CENTER */}
            <div className="md:absolute md:left-1/2 md:-translate-x-1/2">
              Made in 🇮🇳 for the world
            </div>
            {/* RIGHT */}
            <div className="text-muted-foreground/70">
              © 2026 Spacesuite Technologies LLP
            </div>
          </div>
        </div>
      </footer>

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
    </div>
  );
}
