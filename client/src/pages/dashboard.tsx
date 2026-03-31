import { motion } from "framer-motion";
import { useLocation, Link } from "wouter";
import { FileText, TrendingUp, Coins, Upload, ArrowRight, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardLayout } from "@/components/DashboardLayout";
import { useAuth } from "@/context/auth-context";
import { useCredits } from "@/hooks/use-credits";
import { useContracts } from "@/hooks/use-contracts";

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  delay,
  iconColor = "text-primary/60",
  iconBg = "bg-primary/8",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
  delay: number;
  iconColor?: string;
  iconBg?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      className="rounded-xl border border-border bg-white p-5"
    >
      <div className="flex items-center gap-2.5 mb-3">
        <div className={`p-1.5 rounded-lg ${iconBg}`}>
          <Icon className={`h-3.5 w-3.5 ${iconColor}`} />
        </div>
        <span className="text-[11px] text-muted-foreground font-medium">{label}</span>
      </div>
      <p className="text-2xl font-semibold">{value}</p>
      {sub && <p className="text-[12px] text-muted-foreground mt-1">{sub}</p>}
    </motion.div>
  );
}

function DashboardContent() {
  const { user } = useAuth();
  const credits = useCredits();
  const [, setLocation] = useLocation();
  const { data: contracts = [], isLoading: contractsLoading } = useContracts();

  return (
    <div className="w-full max-w-[960px] mx-auto space-y-7">
      <div>
        <h1 className="text-xl font-semibold mb-1">
          Welcome back, {user?.name?.split(" ")[0] || "Counsel"}
        </h1>
        <p className="text-sm text-muted-foreground">Your contract analysis overview.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          icon={Coins}
          label="Credits Remaining"
          value={credits.displayRemaining}
          sub={`of ${credits.displayTotal} on ${credits.plan_name} plan`}
          delay={0.05}
          iconColor="text-green-600"
          iconBg="bg-green-100"
        />
        <StatCard
          icon={TrendingUp}
          label="Credits Used"
          value={credits.displayUsed}
          sub={
            credits.hasOverage
              ? `${credits.overage_credits} overage (${credits.displayOverageCost})`
              : "This billing period"
          }
          delay={0.1}
          iconColor="text-blue-600"
          iconBg="bg-blue-100"
        />
        <StatCard
          icon={FileText}
          label="Est. Analyses Left"
          value={
            credits.credits_remaining > 0
              ? `~${Math.floor(credits.credits_remaining / credits.CREDIT_COSTS.ANALYSIS_DEFAULT)}`
              : "0"
          }
          sub={`at ${credits.CREDIT_COSTS.ANALYSIS_DEFAULT} credits each`}
          delay={0.15}
          iconColor="text-purple-600"
          iconBg="bg-purple-100"
        />
      </div>

      {/* Credit usage bar */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.3 }}
        className="rounded-xl border border-border bg-white p-5"
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] font-medium">Credit Usage</span>
          <span className="text-[11px] text-muted-foreground">
            {credits.displayUsed} / {credits.displayTotal}
          </span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, credits.usagePercent)}%` }}
            transition={{ duration: 0.6 }}
            className={`h-full rounded-full ${
              credits.usagePercent > 90
                ? "bg-red-500"
                : credits.usagePercent > 70
                  ? "bg-amber-500"
                  : "bg-primary"
            }`}
          />
        </div>
        {credits.isOverLimit && (
          <p className="text-[11px] text-red-500 mt-2">
            Credit limit reached.{" "}
            <button
              onClick={() => setLocation("/billing")}
              className="text-primary underline"
            >
              Upgrade plan
            </button>
          </p>
        )}
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25, duration: 0.3 }}
        className="rounded-xl border-2 border-dashed border-border bg-white p-8 text-center"
      >
        <Upload className="h-7 w-7 text-primary/40 mx-auto mb-3" />
        <h3 className="text-sm font-semibold mb-1">New Analysis</h3>
        <p className="text-[13px] text-muted-foreground mb-1">
          Upload a PDF or DOCX contract for review
        </p>
        <p className="text-[11px] text-primary mb-4">
          Estimated cost: ~{credits.CREDIT_COSTS.ANALYSIS_DEFAULT} credits
        </p>
        <Button
          size="sm"
          onClick={() => setLocation("/upload")}
          disabled={credits.isOverLimit && credits.plan_id === "free"}
          data-testid="dashboard-upload-btn"
        >
          Upload Contract <ArrowRight className="ml-2 h-3.5 w-3.5" />
        </Button>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.3 }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">Recent Contracts</h2>
          <Link href="/reports">
            <span className="text-[12px] text-primary hover:underline cursor-pointer">
              View all
            </span>
          </Link>
        </div>
        <div className="space-y-2">
          {contractsLoading ? (
            <div className="rounded-xl border border-border bg-white p-4 text-center">
              <p className="text-[12px] text-muted-foreground">Loading contracts...</p>
            </div>
          ) : contracts.length === 0 ? (
            <div className="rounded-xl border border-border bg-white p-4 text-center">
              <p className="text-[12px] text-muted-foreground">
                No contracts yet. Upload your first one.
              </p>
            </div>
          ) : (
            contracts.slice(0, 5).map((c, i) => (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35 + i * 0.04, duration: 0.25 }}
                className="flex items-center gap-4 rounded-xl border border-border bg-white p-4 hover:border-primary/20 transition-colors cursor-pointer"
                onClick={() => setLocation("/reports")}
                data-testid={`contract-${c.id}`}
              >
                <div className="h-9 w-9 rounded-lg bg-card flex items-center justify-center border border-border">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium truncate">{c.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="text-[11px] text-muted-foreground">
                      {c.created_at?.slice(0, 10) ?? ""}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span
                    className={`text-sm font-semibold ${
                      (c.risk_score ?? 0) >= 70
                        ? "text-red-500"
                        : (c.risk_score ?? 0) >= 40
                          ? "text-amber-500"
                          : "text-green-500"
                    }`}
                  >
                    {c.risk_score ?? "—"}
                  </span>
                  <p className="text-[11px] text-muted-foreground">
                    {c.high_risk_count ?? 0} high risk
                  </p>
                </div>
              </motion.div>
            ))
          )}
        </div>
      </motion.div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <DashboardLayout>
      <DashboardContent />
    </DashboardLayout>
  );
}
