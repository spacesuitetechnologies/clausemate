import { motion } from "framer-motion";

interface RiskScoreCircleProps {
  score: number;
  size?: number;
}

export function RiskScoreCircle({ score, size = 160 }: RiskScoreCircleProps) {
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  const getColor = (s: number) => {
    if (s >= 70) return "#dc2626";
    if (s >= 40) return "#d97706";
    return "#16a34a";
  };
  const getLabel = (s: number) => {
    if (s >= 70) return "High Risk";
    if (s >= 40) return "Medium Risk";
    return "Low Risk";
  };

  const color = getColor(score);

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="hsl(230 15% 92%)" strokeWidth={strokeWidth} />
        <motion.circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <motion.span
          className="text-3xl font-semibold"
          style={{ color }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
        >
          {score}
        </motion.span>
        <span className="text-[10px] text-muted-foreground mt-0.5">/100</span>
        <span className="text-[10px] font-medium mt-1 tracking-wide uppercase" style={{ color }}>
          {getLabel(score)}
        </span>
      </div>
    </div>
  );
}
