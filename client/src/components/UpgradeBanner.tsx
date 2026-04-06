import { motion } from "framer-motion";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

export function UpgradeBanner({ feature = "this feature" }: { feature?: string }) {
  const [, setLocation] = useLocation();
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-lg border border-primary/15 bg-primary/[0.03] p-5"
    >
      <div className="flex items-center gap-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/8">
          <Lock className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">
            Upgrade to Professional to access {feature}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            100 contracts/month · full analysis · redlines · rewrites
          </p>
        </div>
        <Button size="sm" onClick={() => setLocation("/billing")} data-testid="upgrade-banner-btn">
          Upgrade Plan
        </Button>
      </div>
    </motion.div>
  );
}
