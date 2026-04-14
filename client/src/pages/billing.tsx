import { motion } from "framer-motion";
import { Check, ChevronRight, CreditCard, FileText, Zap, Users, Star, Shield, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardLayout } from "@/components/DashboardLayout";
import { useAuth } from "@/context/auth-context";
import { useCredits } from "@/hooks/use-credits";
import { PLANS, formatPrice, type PlanId } from "@/lib/credits";

const PLAN_ICONS: Record<string, React.ElementType> = {
  free: FileText,
  starter: Zap,
  professional: Star,
  enterprise: Users,
};

const LAWYER_COST = 2000; // ₹ per contract — comparison baseline

function PlanCard({
  plan,
  isCurrent,
  onUpgrade,
  delay,
}: {
  plan: (typeof PLANS)[number];
  isCurrent: boolean;
  onUpgrade: (id: PlanId) => void;
  delay: number;
}) {
  const Icon = PLAN_ICONS[plan.id] ?? FileText;
  const saving = plan.price_per_contract > 0 ? LAWYER_COST - plan.price_per_contract : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.35 }}
      className={`relative rounded-2xl flex flex-col transition-all duration-300 ${
        plan.popular
          ? "border-0 p-px bg-gradient-to-b from-primary/60 via-primary/30 to-primary/10 shadow-[0_8px_40px_rgba(59,130,246,0.22)] hover:shadow-[0_12px_48px_rgba(59,130,246,0.32)] hover:-translate-y-1"
          : "border border-border bg-white hover:-translate-y-0.5 hover:shadow-lg"
      } ${isCurrent && !plan.popular ? "ring-2 ring-primary/20" : ""}`}
    >
      {/* Inner white surface for popular card */}
      <div className={`flex flex-col flex-1 rounded-2xl ${plan.popular ? "bg-white m-px" : ""} p-5`}>
        {plan.popular && (
          <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 z-10">
            <span className="text-[10px] uppercase tracking-widest font-bold text-white bg-primary px-3.5 py-1 rounded-full shadow-sm whitespace-nowrap">
              {plan.badge}
            </span>
          </div>
        )}

        {/* Plan header */}
        <div className="flex items-center gap-2 mb-4">
          <div className={`h-8 w-8 rounded-xl flex items-center justify-center shrink-0 ${plan.popular ? "bg-primary/10" : "bg-muted"}`}>
            <Icon className={`h-4 w-4 ${plan.popular ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div>
            <p className="text-[13px] font-semibold leading-tight">{plan.name}</p>
            <p className="text-[10px] text-muted-foreground leading-tight">{plan.tagline}</p>
          </div>
        </div>

        {/* Price */}
        <div className="mb-1">
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tracking-tight">{formatPrice(plan.monthly_price)}</span>
            {plan.monthly_price > 0 && (
              <span className="text-[12px] text-muted-foreground font-normal">/month</span>
            )}
          </div>
          {plan.price_per_contract > 0 ? (
            <p className={`text-[12px] font-semibold mt-0.5 ${plan.popular ? "text-primary" : "text-foreground/70"}`}>
              ≈ {formatPrice(plan.price_per_contract)} per contract
            </p>
          ) : (
            <p className="text-[12px] text-muted-foreground mt-0.5">Free forever</p>
          )}
        </div>

        {/* Savings badge */}
        {saving && saving > 0 && (
          <div className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold mb-3 w-fit ${
            plan.popular ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-muted text-muted-foreground"
          }`}>
            <TrendingDown className="h-2.5 w-2.5" />
            Save {formatPrice(saving)} vs lawyer review
          </div>
        )}

        {/* Contracts */}
        <div className={`rounded-lg px-3 py-2 mb-4 ${plan.popular ? "bg-primary/5 border border-primary/10" : "bg-muted/60"}`}>
          <p className={`text-[13px] font-bold ${plan.popular ? "text-primary" : "text-foreground"}`}>
            {plan.contracts_per_month} contracts/month
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{plan.analysis_depth}</p>
        </div>

        {/* Features */}
        <ul className="space-y-2.5 mb-5 flex-1">
          {plan.features.map((f) => (
            <li key={f} className="flex items-start gap-2">
              <Check className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${plan.popular ? "text-primary" : "text-muted-foreground"}`} />
              <span className="text-[11.5px] text-muted-foreground leading-snug">{f}</span>
            </li>
          ))}
        </ul>

        {/* CTA */}
        {isCurrent ? (
          <Button variant="outline" size="sm" className="w-full h-9" disabled>
            Current Plan
          </Button>
        ) : plan.id === "free" ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full h-9 text-muted-foreground"
            onClick={() => onUpgrade(plan.id as PlanId)}
            data-testid={`upgrade-${plan.id}-btn`}
          >
            Downgrade to Free
          </Button>
        ) : (
          <Button
            variant={plan.popular ? "default" : "outline"}
            size="sm"
            className={`w-full h-9 font-semibold ${plan.popular ? "shadow-sm shadow-primary/20" : ""}`}
            onClick={() => onUpgrade(plan.id as PlanId)}
            data-testid={`upgrade-${plan.id}-btn`}
          >
            {plan.cta}
            <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </motion.div>
  );
}

function BillingContent() {
  const { upgradePlan } = useAuth();
  const credits = useCredits();

  const usageColor =
    credits.contractsPercent > 80 ? "bg-red-500"
    : credits.contractsPercent > 50 ? "bg-amber-400"
    : "bg-emerald-500";

  const usageShadow =
    credits.contractsPercent > 80 ? "shadow-[0_0_10px_rgba(239,68,68,0.3)]"
    : credits.contractsPercent > 50 ? "shadow-[0_0_10px_rgba(234,179,8,0.25)]"
    : "shadow-[0_0_10px_rgba(16,185,129,0.2)]";

  return (
    <div className="w-full max-w-[980px] mx-auto space-y-7">

      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold mb-1">Billing</h1>
        <p className="text-sm text-muted-foreground">Manage your subscription and contract usage.</p>
      </div>

      {/* Current plan + usage */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl border border-border bg-white p-6 shadow-sm"
      >
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <p className="text-[10px] text-muted-foreground font-semibold mb-1.5 uppercase tracking-widest">Current Plan</p>
            <div className="flex items-center gap-2">
              <p className="text-2xl font-bold">{credits.plan_name}</p>
              {credits.plan.popular && (
                <span className="text-[10px] font-semibold text-primary bg-primary/8 border border-primary/15 px-2 py-0.5 rounded-full">
                  Most Popular
                </span>
              )}
            </div>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              {formatPrice(credits.plan.monthly_price)}{credits.plan.monthly_price > 0 ? "/month" : " forever"}
              {credits.plan.price_per_contract > 0 && (
                <span className="text-primary font-medium"> · {formatPrice(credits.plan.price_per_contract)}/contract</span>
              )}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-4xl font-bold text-foreground leading-none tabular-nums">
              {credits.contractsRemaining}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1.5">contracts remaining</p>
          </div>
        </div>

        {/* Usage bar */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold text-foreground">Contracts used this month</span>
            <span className="text-[12px] font-semibold text-foreground tabular-nums">
              {credits.contractsUsed} / {credits.contractsTotal}
            </span>
          </div>
          <div className={`h-3 rounded-full bg-muted overflow-hidden ${usageShadow}`}>
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(100, credits.contractsPercent)}%` }}
              transition={{ duration: 0.8, ease: [0.25, 0.46, 0.45, 0.94] }}
              className={`h-full rounded-full ${usageColor}`}
            />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            {credits.contractsRemaining} of {credits.contractsTotal} contracts remaining this billing period
          </p>
        </div>

        {/* Alerts */}
        {credits.hasOverage && (
          <div className="mt-4 p-3.5 rounded-xl bg-amber-50 border border-amber-200">
            <p className="text-[12px] font-semibold text-amber-800">
              Overage usage — {credits.displayOverageCost} will be charged on your next invoice.
            </p>
            <p className="text-[11px] text-amber-700 mt-0.5">
              Upgrade to avoid overage charges.
            </p>
          </div>
        )}
        {!credits.hasOverage && credits.contractsPercent >= 80 && (
          <div className="mt-4 p-3.5 rounded-xl bg-orange-50 border border-orange-200">
            <p className="text-[12px] font-semibold text-orange-800">
              You're nearing your limit — only {credits.contractsRemaining} contracts left this month.
            </p>
            <p className="text-[11px] text-orange-700 mt-0.5">
              Upgrade now or buy extra contracts below to avoid interruption.
            </p>
          </div>
        )}
      </motion.div>

      {/* Value context banner */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.06 }}
        className="rounded-2xl bg-gradient-to-r from-primary/[0.06] via-primary/[0.04] to-transparent border border-primary/10 px-5 py-4 flex items-center gap-4"
      >
        <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <TrendingDown className="h-4 w-4 text-primary" />
        </div>
        <div>
          <p className="text-[13px] font-semibold text-foreground">
            Save up to ₹1,970 per contract vs traditional lawyer review
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Lawyer review typically costs ₹2,000+ per contract · Professional plan works out to just ₹30/contract
          </p>
        </div>
      </motion.div>

      {/* Plan cards */}
      <div>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-sm font-semibold">
              {credits.plan_id === "free" ? "Upgrade your plan" : "Available plans"}
            </h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">Limited-time pricing · Cancel anytime</p>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Shield className="h-3.5 w-3.5" />
            <span>Secure &amp; confidential</span>
          </div>
        </div>

        <div className="grid md:grid-cols-4 gap-4 items-start">
          {PLANS.map((plan, i) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              isCurrent={credits.plan_id === plan.id}
              onUpgrade={upgradePlan}
              delay={i * 0.07}
            />
          ))}
        </div>

        {/* Trust strip */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35 }}
          className="text-center text-[11px] text-muted-foreground mt-5"
        >
          Used by founders, startups &amp; legal teams across India · Secure &amp; confidential · Cancel anytime
        </motion.p>
      </div>

      {/* Pay-as-you-go */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18 }}
        className="rounded-2xl border border-border bg-white p-6 shadow-sm"
      >
        <div className="mb-5">
          <h3 className="text-sm font-semibold">Need just a few? Pay per contract</h3>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            One-time top-up · No subscription · Instant access
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {credits.PAYG_OPTIONS.map((opt) => (
            <div
              key={opt.contracts}
              className="group flex items-center justify-between gap-8 rounded-xl border border-border bg-card px-5 py-4 hover:border-primary/30 hover:bg-primary/[0.02] hover:shadow-sm transition-all duration-200 cursor-pointer min-w-[220px]"
            >
              <div>
                <p className="text-[13px] font-semibold">{opt.label}</p>
                <p className="text-[11px] text-muted-foreground">≈ {formatPrice(Math.round(opt.price / opt.contracts))}/contract</p>
              </div>
              <div className="text-right">
                <p className="text-[15px] font-bold text-foreground">{formatPrice(opt.price)}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1.5 h-7 text-[11px] px-3 group-hover:border-primary/40 group-hover:text-primary transition-colors"
                  data-testid={`payg-${opt.contracts}-btn`}
                >
                  Buy Now
                </Button>
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Payment method */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.22 }}
        className="rounded-2xl border border-border bg-white p-6 shadow-sm"
      >
        <h3 className="text-sm font-semibold mb-3">Payment Method</h3>
        <div className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card">
          <CreditCard className="h-5 w-5 text-muted-foreground shrink-0" />
          <div>
            <p className="text-[13px] font-medium">No payment method added</p>
            <p className="text-[11px] text-muted-foreground">Payments powered by Razorpay — secure &amp; encrypted</p>
          </div>
          <Button variant="outline" size="sm" className="ml-auto shrink-0" data-testid="add-payment-btn">
            Add Card
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

export default function BillingPage() {
  return <DashboardLayout><BillingContent /></DashboardLayout>;
}
