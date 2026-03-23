import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config";
import * as schema from "./schema";
import { eq } from "drizzle-orm";

async function runMigrations() {
  console.log("Running migrations...");

  const migrationClient = postgres(config.database.url, { max: 1 });
  const db = drizzle(migrationClient, { schema });

  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");

  // Seed plans
  console.log("Seeding plans...");
  const planData = [
    {
      id: "free" as const,
      name: "Free",
      monthlyPrice: 0,
      credits: 10,
      overageRate: "0",
      features: [
        "1 contract (basic analysis only)",
        "10 credits included",
        "No redlines or rewrites",
        "Email support",
      ],
    },
    {
      id: "starter" as const,
      name: "Starter",
      monthlyPrice: 999,
      credits: 100,
      overageRate: "15",
      features: [
        "100 credits per month",
        "~10 contract analyses",
        "Basic analysis + limited redlines",
        "Email support",
        "₹15 per extra credit",
      ],
    },
    {
      id: "professional" as const,
      name: "Professional",
      monthlyPrice: 2999,
      credits: 400,
      overageRate: "12",
      features: [
        "400 credits per month",
        "~40 contract analyses",
        "Full analysis + redlines + rewrites",
        "Priority support",
        "₹12 per extra credit",
      ],
    },
    {
      id: "enterprise" as const,
      name: "Enterprise",
      monthlyPrice: 9999,
      credits: 1500,
      overageRate: "8",
      features: [
        "1,500+ credits per month",
        "~150 contract analyses",
        "Full analysis + redlines + rewrites",
        "Multi-user & team features",
        "Dedicated account manager",
        "₹8 per extra credit",
      ],
    },
  ];

  for (const plan of planData) {
    const existing = await db.select().from(schema.plans).where(eq(schema.plans.id, plan.id));
    if (existing.length === 0) {
      await db.insert(schema.plans).values(plan);
      console.log(`  Seeded plan: ${plan.name}`);
    } else {
      console.log(`  Plan already exists: ${plan.name}`);
    }
  }

  // Seed default policies
  console.log("Seeding policies...");
  const policyData = [
    {
      name: "Extended Payment Terms",
      category: "payment",
      conditionField: "payment_days",
      conditionOperator: ">",
      conditionValue: "60",
      riskLevel: "high" as const,
      explanationTemplate: "Payment terms exceed 60 days, creating significant cash flow risk",
      isActive: true,
    },
    {
      name: "Long Payment Terms",
      category: "payment",
      conditionField: "payment_days",
      conditionOperator: ">",
      conditionValue: "30",
      riskLevel: "medium" as const,
      explanationTemplate: "Payment terms exceed standard 30 days",
      isActive: true,
    },
    {
      name: "Uncapped Liability",
      category: "liability",
      conditionField: "liability",
      conditionOperator: "===",
      conditionValue: "uncapped",
      riskLevel: "high" as const,
      explanationTemplate: "Liability is uncapped — consider adding a liability cap",
      isActive: true,
    },
    {
      name: "Extended Non-Compete",
      category: "non_compete",
      conditionField: "non_compete_months",
      conditionOperator: ">",
      conditionValue: "12",
      riskLevel: "high" as const,
      explanationTemplate: "Non-compete exceeds 12 months — may be unenforceable",
      isActive: true,
    },
    {
      name: "Long Non-Compete",
      category: "non_compete",
      conditionField: "non_compete_months",
      conditionOperator: ">",
      conditionValue: "6",
      riskLevel: "medium" as const,
      explanationTemplate: "Non-compete exceeds 6 months",
      isActive: true,
    },
    {
      name: "Broad IP Assignment",
      category: "ip",
      conditionField: "ip_assignment",
      conditionOperator: "===",
      conditionValue: "all",
      riskLevel: "high" as const,
      explanationTemplate: "Overly broad IP assignment — all intellectual property transferred",
      isActive: true,
    },
    {
      name: "Asymmetric Termination",
      category: "termination",
      conditionField: "termination_asymmetric",
      conditionOperator: "===",
      conditionValue: "true",
      riskLevel: "medium" as const,
      explanationTemplate: "Asymmetric termination rights — one party has more favorable terms",
      isActive: true,
    },
    {
      name: "Unilateral Arbitrator",
      category: "dispute",
      conditionField: "arbitrator_unilateral",
      conditionOperator: "===",
      conditionValue: "true",
      riskLevel: "medium" as const,
      explanationTemplate: "Unilateral arbitrator appointment — consider mutual selection",
      isActive: true,
    },
    {
      name: "Unlimited Indemnification",
      category: "indemnification",
      conditionField: "indemnification",
      conditionOperator: "===",
      conditionValue: "unlimited",
      riskLevel: "high" as const,
      explanationTemplate: "Unlimited indemnification obligation — significant financial risk",
      isActive: true,
    },
    {
      name: "Auto-Renewal Without Notice",
      category: "renewal",
      conditionField: "auto_renewal_no_notice",
      conditionOperator: "===",
      conditionValue: "true",
      riskLevel: "medium" as const,
      explanationTemplate: "Auto-renewal without adequate notice period",
      isActive: true,
    },
    {
      name: "Exclusive Jurisdiction",
      category: "jurisdiction",
      conditionField: "exclusive_jurisdiction_foreign",
      conditionOperator: "===",
      conditionValue: "true",
      riskLevel: "medium" as const,
      explanationTemplate: "Exclusive foreign jurisdiction clause — may increase litigation costs",
      isActive: true,
    },
    {
      name: "Broad Confidentiality",
      category: "confidentiality",
      conditionField: "confidentiality_years",
      conditionOperator: ">",
      conditionValue: "5",
      riskLevel: "medium" as const,
      explanationTemplate: "Confidentiality period exceeds 5 years — consider shorter duration",
      isActive: true,
    },
  ];

  for (const policy of policyData) {
    const existing = await db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.name, policy.name));
    if (existing.length === 0) {
      await db.insert(schema.policies).values(policy);
      console.log(`  Seeded policy: ${policy.name}`);
    }
  }

  console.log("Seeding complete.");
  await migrationClient.end();
  process.exit(0);
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
