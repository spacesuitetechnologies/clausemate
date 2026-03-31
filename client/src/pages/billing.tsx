import { motion } from "framer-motion";
import { Check, ChevronRight, CreditCard, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardLayout } from "@/components/DashboardLayout";
import { useAuth } from "@/context/auth-context";
import { useCredits } from "@/hooks/use-credits";
import { PLANS, formatPrice, type PlanId } from "@/lib/credits";

function BillingContent() {
  const { upgradePlan } = useAuth();
  const credits = useCredits();

  return (
    <div className="w-full max-w-[960px] mx-auto space-y-6">
      <div><h1 className="text-xl font-semibold mb-1">Billing</h1><p className="text-sm text-muted-foreground">Manage your subscription, credits, and usage.</p></div>

      {/* Current plan + credit usage */}
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-border bg-white p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-[11px] text-muted-foreground font-medium mb-1">Current Plan</p>
            <p className="text-lg font-semibold">{credits.plan_name}</p>
            <p className="text-[13px] text-muted-foreground mt-0.5">{formatPrice(credits.plan.monthly_price)}{credits.plan.monthly_price > 0 ? "/month" : " forever"}</p>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-1.5 justify-end mb-1">
              <Coins className="h-4 w-4 text-primary" />
              <span className="text-2xl font-semibold text-primary">{credits.displayRemaining}</span>
            </div>
            <p className="text-xs text-muted-foreground">credits remaining</p>
          </div>
        </div>

        {/* Usage bar */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-muted-foreground">Credit Usage</span>
            <span className="text-[11px] text-muted-foreground">{credits.displayUsed} / {credits.displayTotal}</span>
          </div>
          <div className={`h-2 rounded-full bg-muted overflow-hidden transition-shadow duration-500 ${
            credits.usagePercent > 80
              ? "shadow-[0_0_8px_rgba(239,68,68,0.35)]"
              : credits.usagePercent > 50
                ? "shadow-[0_0_8px_rgba(234,179,8,0.35)]"
                : "shadow-[0_0_8px_rgba(34,197,94,0.25)]"
          }`}>
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(100, credits.usagePercent)}%` }}
              transition={{ duration: 0.6 }}
              className={`h-full rounded-full transition-colors duration-500 ${
                credits.usagePercent > 80
                  ? "bg-red-500"
                  : credits.usagePercent > 50
                    ? "bg-yellow-500"
                    : "bg-green-500"
              }`}
            />
          </div>
        </div>

        {/* Overage info */}
        {credits.hasOverage && (
          <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
            <p className="text-[12px] font-medium text-amber-700">Overage: {credits.overage_credits} credits ({credits.displayOverageCost})</p>
            <p className="text-[11px] text-amber-600 mt-0.5">Charged at {credits.overageRate}/credit on your next invoice.</p>
          </div>
        )}
      </motion.div>

      {/* Credit cost reference */}
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="rounded-xl border border-border bg-white p-6">
        <h3 className="text-sm font-semibold mb-3">Credit Costs</h3>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Contract Analysis", cost: `${credits.CREDIT_COSTS.ANALYSIS_MIN}–${credits.CREDIT_COSTS.ANALYSIS_MAX}`, unit: "credits" },
            { label: "Clause Redline", cost: String(credits.CREDIT_COSTS.REDLINE), unit: "credits/clause" },
            { label: "Full Rewrite", cost: String(credits.CREDIT_COSTS.REWRITE), unit: "credits/clause" },
          ].map((item) => (
            <div key={item.label} className="text-center p-3 rounded-lg bg-card border border-border/40">
              <p className="text-lg font-semibold text-primary">{item.cost}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{item.unit}</p>
              <p className="text-[11px] font-medium mt-1">{item.label}</p>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Plan cards */}
      <div>
        <h2 className="text-sm font-semibold mb-4">{credits.plan_id === "free" ? "Upgrade your plan" : "Available plans"}</h2>
        <div className="grid md:grid-cols-4 gap-4">
          {PLANS.map((plan, i) => {
            const isCurrent = credits.plan_id === plan.id;
            return (
              <motion.div key={plan.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                className={`relative rounded-xl border p-5 bg-white cursor-default transition-all duration-300 ease-out ${
                  plan.popular
                    ? "border-primary shadow-md hover:scale-[1.02] hover:shadow-[0_10px_30px_rgba(59,130,246,0.25)]"
                    : "border-border hover:-translate-y-1 hover:shadow-lg"
                } ${isCurrent ? "ring-1 ring-primary/30" : ""}`}>
                {plan.popular && <div className="absolute -top-3 left-1/2 -translate-x-1/2"><span className="text-[10px] uppercase tracking-wider font-semibold text-white bg-primary px-2.5 py-0.5 rounded-full">Recommended</span></div>}
                <p className="text-[13px] font-semibold">{plan.name}</p>
                <div className="flex items-baseline gap-0.5 mt-2"><span className="text-xl font-semibold">{formatPrice(plan.monthly_price)}</span>{plan.monthly_price > 0 && <span className="text-xs text-muted-foreground">/mo</span>}</div>
                <p className="text-[11px] text-primary font-medium mt-1 mb-3">{plan.credits} credits</p>
                <ul className="space-y-1.5 mb-4">
                  {plan.features.slice(0, 4).map(f => <li key={f} className="flex items-start gap-1.5"><Check className="h-3 w-3 text-primary/60 shrink-0 mt-0.5" /><span className="text-[11px] text-muted-foreground leading-snug">{f}</span></li>)}
                </ul>
                {isCurrent ? <Button variant="outline" size="sm" className="w-full" disabled>Current Plan</Button> : (
                  <Button variant={plan.popular ? "default" : "outline"} size="sm" className="w-full" onClick={() => upgradePlan(plan.id as PlanId)} data-testid={`upgrade-${plan.id}-btn`}>
                    {plan.id === "free" ? "Downgrade" : "Upgrade"} <ChevronRight className="ml-1 h-3 w-3" />
                  </Button>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Payment method */}
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="rounded-xl border border-border bg-white p-6">
        <h3 className="text-sm font-semibold mb-3">Payment Method</h3>
        <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <div><p className="text-[13px] font-medium">No payment method added</p><p className="text-[11px] text-muted-foreground">Add a payment method to upgrade</p></div>
          <Button variant="outline" size="sm" className="ml-auto" data-testid="add-payment-btn">Add</Button>
        </div>
      </motion.div>
    </div>
  );
}

export default function BillingPage() { return <DashboardLayout><BillingContent /></DashboardLayout>; }
