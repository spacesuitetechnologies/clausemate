import { motion } from "framer-motion";

export function RiskBar({ score, showLabel = true }: { score: number; showLabel?: boolean }) {
  const getColor = (s: number) => {
    if (s >= 70) return { bar: "#dc2626", bg: "rgba(220,38,38,0.1)", label: "High Risk" };
    if (s >= 40) return { bar: "#d97706", bg: "rgba(217,119,6,0.1)", label: "Medium Risk" };
    return { bar: "#16a34a", bg: "rgba(22,163,74,0.1)", label: "Low Risk" };
  };
  const { bar, bg, label } = getColor(score);

  return (
    <div className="w-full">
      {showLabel && (
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold" style={{ color: bar }}>
            Risk Score: {score}/100
          </span>
          <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: bar }}>
            {label}
          </span>
        </div>
      )}
      <div className="h-2.5 rounded-full overflow-hidden" style={{ background: bg }}>
        <motion.div
          className="h-full rounded-full"
          style={{ background: `linear-gradient(90deg, #16a34a, #d97706 50%, #dc2626)`, width: "100%" }}
          initial={{ clipPath: "inset(0 100% 0 0)" }}
          animate={{ clipPath: `inset(0 ${100 - score}% 0 0)` }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
    </div>
  );
}
