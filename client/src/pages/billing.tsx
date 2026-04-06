import { motion } from "framer-motion";
import { Check, ChevronRight, CreditCard, FileText, Zap, Users, Star } from "lucide-react";
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

function BillingContent() {
  const { upgradePlan } = useAuth();
  const credits = useCredits();

  const usageColor =
    credits.contractsPercent > 80
      ? "bg-red-500"
      : credits.contractsPercent > 50
        ? "bg-yellow-500"
        : "bg-emerald-500";

  const usageShadow =
    credits.contractsPercent > 80
      ? "shadow-[0_0_8px_rgba(239,68,68,0.3)]"
      : credits.contractsPercent > 50
        ? "shadow-[0_0_8px_rgba(234,179,8,0.25)]"
        : "shadow-[0_0_8px_rgba(16,185,129,0.2)]";

  return (
    <div className="w-full max-w-[960px] mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold mb-1">Billing</h1>
        <p className="text-sm text-muted-foreground">Manage your subscription and contract usage.</p>
      </div>

      {/* Current plan + usage */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-border bg-white p-6"
      >
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <p className="text-[11px] text-muted-foreground font-medium mb-1 uppercase tracking-wide">Current Plan</p>
            <p className="text-xl font-semibold">{credits.plan_name}</p>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              {formatPrice(credits.plan.monthly_price)}{credits.plan.monthly_price > 0 ? "/month" : " forever"}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-3xl font-semibold text-foreground leading-none">
              {credits.contractsRemaining}
            </p>
            <p className="text-xs text-muted-foreground mt-1">contracts remaining</p>
          </div>
        </div>

        {/* Usage bar */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-medium text-foreground">Contracts used this month</span>
            <span className="text-[12px] font-medium text-foreground">
              {credits.contractsUsed} / {credits.contractsTotal}
            </span>
          </div>
          <div className={`h-2.5 rounded-full bg-muted overflow-hidden transition-shadow duration-500 ${usageShadow}`}>
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(100, credits.contractsPercent)}%` }}
              transition={{ duration: 0.7, ease: "easeOut" }}
              className={`h-full rounded-full transition-colors duration-500 ${usageColor}`}
            />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            {credits.contractsRemaining} of {credits.contractsTotal} contracts remaining
          </p>
        </div>

        {/* Overage notice */}
        {credits.hasOverage && (
          <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200">
            <p className="text-[12px] font-medium text-amber-700">
              You've used {credits.overage_credits} extra credits this month
            </p>
            <p className="text-[11px] text-amber-600 mt-0.5">
              Overage charge: {credits.displayOverageCost} — will appear on your next invoice.
            </p>
          </div>
        )}

        {/* Near-limit nudge */}
        {!credits.hasOverage && credits.contractsPercent >= 80 && (
          <div className="mt-4 p-3 rounded-lg bg-orange-50 border border-orange-200">
            <p className="text-[12px] font-medium text-orange-700">
              You're nearing your contract limit — {credits.contractsRemaining} left this month.
            </p>
            <p className="text-[11px] text-orange-600 mt-0.5">
              Upgrade your plan or buy extra contracts below.
            </p>
          </div>
        )}
      </motion.div>

      {/* Plan cards */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">
            {credits.plan_id === "free" ? "Upgrade your plan" : "Available plans"}
          </h2>
          <p className="text-[11px] text-muted-foreground">Used by founders &amp; legal teams across India</p>
        </div>

        <div className="grid md:grid-cols-4 gap-4">
          {PLANS.map((plan, i) => {
            const isCurrent = credits.plan_id === plan.id;
            const Icon = PLAN_ICONS[plan.id] ?? FileText;
            return (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
                className={`relative rounded-xl border p-5 bg-white flex flex-col transition-all duration-300 ${
                  plan.popular
                    ? "border-primary shadow-[0_4px_24px_rgba(59,130,246,0.18)] hover:shadow-[0_8px_32px_rgba(59,130,246,0.28)] hover:-translate-y-0.5"
                    : "border-border hover:-translate-y-0.5 hover:shadow-md"
                } ${isCurrent ? "ring-2 ring-primary/25" : ""}`}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-white bg-primary px-3 py-1 rounded-full whitespace-nowrap">
                      {plan.badge ?? "Most Popular"}
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-2 mb-3">
                  <div className={`h-7 w-7 rounded-lg flex items-center justify-center ${plan.popular ? "bg-primary/10" : "bg-muted"}`}>
                    <Icon className={`h-3.5 w-3.5 ${plan.popular ? "text-primary" : "text-muted-foreground"}`} />
                  </div>
                  <p className="text-[13px] font-semibold">{plan.name}</p>
                </div>

                <div className="flex items-baseline gap-0.5 mb-0.5">
                  <span className="text-2xl font-bold">{formatPrice(plan.monthly_price)}</span>
                  {plan.monthly_price > 0 && (
                    <span className="text-xs text-muted-foreground">/mo</span>
                  )}
                </div>

                <p className={`text-[13px] font-semibold mb-4 ${plan.popular ? "text-primary" : "text-foreground"}`}>
                  {plan.contracts_per_month} contracts/month
                </p>

                <ul className="space-y-2 mb-5 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-1.5">
                      <Check className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${plan.popular ? "text-primary" : "text-muted-foreground"}`} />
                      <span className="text-[11px] text-muted-foreground leading-snug">{f}</span>
                    </li>
                  ))}
                </ul>

                {isCurrent ? (
                  <Button variant="outline" size="sm" className="w-full" disabled>
                    Current Plan
                  </Button>
                ) : (
                  <Button
                    variant={plan.popular ? "default" : "outline"}
                    size="sm"
                    className="w-full"
                    onClick={() => upgradePlan(plan.id as PlanId)}
                    data-testid={`upgrade-${plan.id}-btn`}
                  >
                    {plan.id === "free" ? "Downgrade" : plan.cta}
                    <ChevronRight className="ml-1 h-3.5 w-3.5" />
                  </Button>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Pay-as-you-go */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="rounded-xl border border-border bg-white p-6"
      >
        <div className="mb-4">
          <h3 className="text-sm font-semibold">Need more contracts?</h3>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            Buy extra contracts anytime — no subscription needed.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {credits.PAYG_OPTIONS.map((opt) => (
            <div
              key={opt.contracts}
              className="flex items-center justify-between gap-6 rounded-lg border border-border bg-card px-4 py-3 min-w-[200px]"
            >
              <div>
                <p className="text-[13px] font-semibold">{opt.label}</p>
                <p className="text-[11px] text-muted-foreground">one-time top-up</p>
              </div>
              <div className="text-right">
                <p className="text-[13px] font-semibold">{formatPrice(opt.price)}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 h-7 text-[11px] px-3"
                  data-testid={`payg-${opt.contracts}-btn`}
                >
                  Buy Extra Contracts
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
        transition={{ delay: 0.2 }}
        className="rounded-xl border border-border bg-white p-6"
      >
        <h3 className="text-sm font-semibold mb-3">Payment Method</h3>
        <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-[13px] font-medium">No payment method added</p>
            <p className="text-[11px] text-muted-foreground">Add a payment method to upgrade</p>
          </div>
          <Button variant="outline" size="sm" className="ml-auto" data-testid="add-payment-btn">
            Add
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

export default function BillingPage() {
  return <DashboardLayout><BillingContent /></DashboardLayout>;
}
