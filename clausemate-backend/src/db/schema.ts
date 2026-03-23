import {
  pgTable,
  text,
  integer,
  timestamp,
  numeric,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  uuid,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/* ── Enums ────────────────────────────────────────── */

export const planIdEnum = pgEnum("plan_id_enum", [
  "free",
  "starter",
  "professional",
  "enterprise",
]);

export const contractStatusEnum = pgEnum("contract_status", [
  "uploaded",
  "processing",
  "ready",
  "failed",
]);

export const analysisStatusEnum = pgEnum("analysis_status", [
  "queued",
  "processing",
  "completed",
  "failed",
]);

export const riskLevelEnum = pgEnum("risk_level", ["low", "medium", "high", "critical"]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "cancelled",
  "past_due",
  "trialing",
]);

export const creditReservationStatusEnum = pgEnum("credit_reservation_status", [
  "reserved",   // held at queue time, counts against available balance
  "consumed",   // converted to actual spend on worker success
  "released",   // returned to available on final worker failure
]);

/* ── Users ────────────────────────────────────────── */

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    razorpayCustomerId: text("razorpay_customer_id"),
    // Email verification
    emailVerified: boolean("email_verified").notNull().default(false),
    emailVerificationToken: text("email_verification_token"), // SHA-256 hash
    emailVerificationSentAt: timestamp("email_verification_sent_at", { withTimezone: true }),
    // Password reset
    passwordResetToken: text("password_reset_token"),         // SHA-256 hash
    passwordResetExpiresAt: timestamp("password_reset_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("users_email_idx").on(table.email)]
);

export const usersRelations = relations(users, ({ many }) => ({
  subscriptions: many(subscriptions),
  contracts: many(contracts),
  analyses: many(analyses),
  creditUsages: many(creditUsage),
}));

/* ── Plans ────────────────────────────────────────── */

export const plans = pgTable("plans", {
  id: planIdEnum("id").primaryKey(),
  name: text("name").notNull(),
  monthlyPrice: integer("monthly_price").notNull(),
  credits: integer("credits").notNull(),
  overageRate: numeric("overage_rate", { precision: 10, scale: 2 }).notNull(),
  features: jsonb("features").$type<string[]>().notNull(),
});

export const plansRelations = relations(plans, ({ many }) => ({
  subscriptions: many(subscriptions),
}));

/* ── Subscriptions ────────────────────────────────── */

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: planIdEnum("plan_id")
      .notNull()
      .references(() => plans.id),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    razorpaySubscriptionId: text("razorpay_subscription_id"),
    lastInvoiceId: text("last_invoice_id"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true })
      .defaultNow()
      .notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("subscriptions_user_idx").on(table.userId),
    index("subscriptions_status_idx").on(table.status),
    index("subscriptions_razorpay_idx").on(table.razorpaySubscriptionId),
    // Partial unique index: at most one active or trialing subscription per user.
    // Historical cancelled/past_due rows are excluded so the constraint does not
    // block legitimate plan changes or expired subscriptions.
    uniqueIndex("subscriptions_one_active_per_user_idx")
      .on(table.userId)
      .where(sql`status IN ('active', 'trialing')`),
  ]
);

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
  creditUsages: many(creditUsage),
}));

/* ── Credit Reservations ──────────────────────────── */

/**
 * One row per analysis job reservation.
 *
 * State machine: reserved → consumed (on success)
 *                         → released (on final failure)
 *
 * Transitions are enforced by conditional UPDATE … WHERE status = 'reserved'.
 * If 0 rows are updated the caller knows the transition was rejected,
 * preventing double-finalize, double-release, and finalize-after-release.
 *
 * The unique constraint on (userId, analysisId) blocks duplicate reservations
 * for the same analysis, which would bypass the balance check.
 */
export const creditReservations = pgTable(
  "credit_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    reservedAmount: integer("reserved_amount").notNull(),
    actualAmount: integer("actual_amount"),             // set on consume
    status: creditReservationStatusEnum("status").notNull().default("reserved"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("credit_reservations_user_idx").on(table.userId),
    index("credit_reservations_status_idx").on(table.status),
  ]
);

export const creditReservationsRelations = relations(creditReservations, ({ one }) => ({
  user: one(users, { fields: [creditReservations.userId], references: [users.id] }),
  subscription: one(subscriptions, {
    fields: [creditReservations.subscriptionId],
    references: [subscriptions.id],
  }),
}));

/* ── Credit Usage ─────────────────────────────────── */

export const creditUsage = pgTable(
  "credit_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    creditsUsed: integer("credits_used").notNull().default(0),
    creditsReserved: integer("credits_reserved").notNull().default(0),
    creditsRemaining: integer("credits_remaining").notNull(),
    overageCredits: integer("overage_credits").notNull().default(0),
    overageCost: numeric("overage_cost", { precision: 10, scale: 2 }).notNull().default("0"),
    // Cumulative LLM token consumption this billing period (input + output).
    // Enforced against config.llm.maxMonthlyTokensPerUser before each analysis.
    llmTokensUsed: integer("llm_tokens_used").notNull().default(0),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("credit_usage_user_idx").on(table.userId),
    index("credit_usage_period_idx").on(table.periodStart, table.periodEnd),
  ]
);

export const creditUsageRelations = relations(creditUsage, ({ one }) => ({
  user: one(users, { fields: [creditUsage.userId], references: [users.id] }),
  subscription: one(subscriptions, {
    fields: [creditUsage.subscriptionId],
    references: [subscriptions.id],
  }),
}));

/* ── Contracts ────────────────────────────────────── */

export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    originalName: text("original_name").notNull(),
    fileSize: integer("file_size").notNull(),
    mimeType: text("mime_type").notNull(),
    storagePath: text("storage_path").notNull(),
    // SHA-256 hex digest of the file content at upload time.
    // Used to detect duplicate uploads per user and reject them before
    // storage is written, saving disk space and preventing accidental
    // re-analysis of the same document. Not globally unique — two users
    // may legitimately upload the same document.
    fileHash: text("file_hash"),
    status: contractStatusEnum("status").notNull().default("uploaded"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("contracts_user_idx").on(table.userId),
    index("contracts_status_idx").on(table.status),
    // Fast lookup for duplicate detection — (userId, fileHash) pair
    index("contracts_user_hash_idx").on(table.userId, table.fileHash),
  ]
);

export const contractsRelations = relations(contracts, ({ one, many }) => ({
  user: one(users, { fields: [contracts.userId], references: [users.id] }),
  analyses: many(analyses),
}));

/* ── Analyses ─────────────────────────────────────── */

export const analyses = pgTable(
  "analyses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: analysisStatusEnum("status").notNull().default("queued"),
    riskScore: integer("risk_score"),
    creditsEstimated: integer("credits_estimated").notNull().default(0),
    creditsActual: integer("credits_actual"),
    includeRedlines: boolean("include_redlines").notNull().default(false),
    // LLM token usage accumulated across all calls for this analysis
    llmInputTokens: integer("llm_input_tokens"),
    llmOutputTokens: integer("llm_output_tokens"),
    llmCostUsd: numeric("llm_cost_usd", { precision: 10, scale: 6 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    index("analyses_contract_idx").on(table.contractId),
    index("analyses_user_idx").on(table.userId),
    index("analyses_status_idx").on(table.status),
    // Prevents a concurrent double-submission race: two requests that both
    // pass the non-atomic in-flight check cannot both insert a queued/processing
    // row for the same (user, contract) pair. The second INSERT fails with 23505;
    // the route handler releases the reservation and returns 409.
    uniqueIndex("analyses_one_inflight_per_contract_idx")
      .on(table.userId, table.contractId)
      .where(sql`status IN ('queued', 'processing')`),
  ]
);

export const analysesRelations = relations(analyses, ({ one, many }) => ({
  contract: one(contracts, { fields: [analyses.contractId], references: [contracts.id] }),
  user: one(users, { fields: [analyses.userId], references: [users.id] }),
  clauses: many(clauses),
}));

/* ── Clauses ──────────────────────────────────────── */

export const clauses = pgTable(
  "clauses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => analyses.id, { onDelete: "cascade" }),
    clauseNumber: integer("clause_number").notNull(),
    category: text("category").notNull().default("general"),
    title: text("title").notNull(),
    text: text("text").notNull(),
    riskLevel: riskLevelEnum("risk_level").notNull().default("low"),
    score: integer("score").notNull().default(0),
    explanation: text("explanation"),
    suggestedRewrite: text("suggested_rewrite"),
    policyViolations: jsonb("policy_violations").$type<PolicyViolation[]>().default([]),
  },
  (table) => [
    index("clauses_analysis_idx").on(table.analysisId),
    index("clauses_risk_idx").on(table.riskLevel),
    // Prevents duplicate clause rows on worker retry (delete-before-insert is
    // the primary guard; this constraint is the DB-level safety net).
    uniqueIndex("clauses_analysis_clause_unique").on(table.analysisId, table.clauseNumber),
  ]
);

export const clausesRelations = relations(clauses, ({ one }) => ({
  analysis: one(analyses, { fields: [clauses.analysisId], references: [analyses.id] }),
}));

/* ── Policies ─────────────────────────────────────── */

export const policies = pgTable(
  "policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    conditionField: text("condition_field").notNull(),
    conditionOperator: text("condition_operator").notNull(),
    conditionValue: text("condition_value").notNull(),
    riskLevel: riskLevelEnum("risk_level").notNull(),
    explanationTemplate: text("explanation_template").notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    index("policies_category_idx").on(table.category),
    index("policies_active_idx").on(table.isActive),
  ]
);

/* ── Webhook Events (idempotency) ─────────────────── */

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: text("event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("webhook_events_event_id_idx").on(table.eventId)]
);

/* ── Helper Types ─────────────────────────────────── */

export interface PolicyViolation {
  policyId: string;
  policyName: string;
  riskLevel: string;
  explanation: string;
}
