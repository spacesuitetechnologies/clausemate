import { motion } from "framer-motion";
import { useRef } from "react";
import { useInView } from "framer-motion";
import { Rocket, Building, Briefcase, Scale } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Link } from "wouter";

const fadeUp = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0 } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.1 } } };

const audiences = [
  {
    icon: Rocket,
    color: "text-indigo-500",
    bg: "bg-indigo-50",
    title: "Startups & Founders",
    bullets: [
      "Understand investor agreements, SAFEs, and term sheets before signing",
      "Catch hidden clauses in co-founder and vesting agreements",
      "Review vendor contracts without expensive legal retainers",
    ],
  },
  {
    icon: Building,
    color: "text-emerald-600",
    bg: "bg-emerald-50",
    title: "MSMEs & Businesses",
    bullets: [
      "Analyze vendor and supplier contracts for payment and liability risks",
      "Ensure compliance with MSME Act payment terms",
      "Review lease, service, and procurement agreements with confidence",
    ],
  },
  {
    icon: Briefcase,
    color: "text-amber-600",
    bg: "bg-amber-50",
    title: "Freelancers & Consultants",
    bullets: [
      "Protect your intellectual property in client agreements",
      "Identify unfair termination and non-compete clauses",
      "Understand indemnification and liability exposure",
    ],
  },
  {
    icon: Scale,
    color: "text-rose-600",
    bg: "bg-rose-50",
    title: "Legal Teams",
    bullets: [
      "Accelerate first-pass contract review with AI assistance",
      "Flag high-risk clauses for senior counsel attention",
      "Generate revision suggestions aligned with Indian law",
    ],
  },
];

function Navbar() {
  return (
    <nav className="border-b border-border/60 bg-white">
      <div className="max-w-[1140px] mx-auto flex items-center justify-between px-6 h-16">
        <Link href="/" className="flex items-center">
          <Logo size={30} />
        </Link>
        <Link href="/">
          <span className="text-[13px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            Back to Home
          </span>
        </Link>
      </div>
    </nav>
  );
}

export default function WhoIsThisForPage() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-40px" });

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <section className="py-20 px-6">
        <div className="max-w-[900px] mx-auto text-center mb-16">
          <p className="text-xs uppercase tracking-[0.18em] text-primary font-medium mb-3">
            Who is this for
          </p>
          <h1 className="font-display text-3xl md:text-4xl mb-4">
            Contract clarity for everyone
          </h1>
          <p className="text-[15px] text-muted-foreground max-w-[480px] mx-auto leading-relaxed">
            Whether you are a solo founder or a legal team, clausemate.ai helps
            you understand what you are signing — in plain language.
          </p>
        </div>

        <motion.div
          ref={ref}
          variants={stagger}
          initial="hidden"
          animate={isInView ? "show" : "hidden"}
          className="max-w-[900px] mx-auto grid sm:grid-cols-2 gap-5"
        >
          {audiences.map((a) => (
            <motion.div
              key={a.title}
              variants={fadeUp}
              transition={{ duration: 0.4 }}
              className="rounded-xl border border-border bg-white p-7"
            >
              <div className={`h-10 w-10 rounded-lg ${a.bg} flex items-center justify-center mb-4`}>
                <a.icon className={`h-5 w-5 ${a.color}`} />
              </div>
              <h3 className="text-sm font-semibold mb-3">{a.title}</h3>
              <ul className="space-y-2">
                {a.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <span className="mt-1.5 h-1 w-1 rounded-full bg-muted-foreground/40 shrink-0" />
                    <span className="text-[13px] text-muted-foreground leading-relaxed">{b}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </motion.div>
      </section>

      <footer className="border-t border-border/60 py-8 px-6">
        <div className="max-w-[1140px] mx-auto text-center text-[11px] text-muted-foreground">
          © 2026 Spacesuite Technologies LLP
        </div>
      </footer>
    </div>
  );
}
