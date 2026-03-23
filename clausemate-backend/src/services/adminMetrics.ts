import { sql, gt, and, eq, desc } from "drizzle-orm";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { getAnalysisQueue } from "../workers/queue";
import { logger } from "./logger";
import { config } from "../config";

/* ── Metrics Snapshot ─────────────────────────────── */

export interface MetricsSnapshot {
  generated_at: string;
  users: {
    total: number;
    new_last_7d: number;
  };
  subscriptions: {
    by_status: Record<string, number>;
    active_by_plan: Record<string, number>;
  };
  analyses: {
    total: number;
    completed: number;
    failed: number;
    queued: number;
    processing: number;
    failure_rate_pct: number;
  };
  credits: {
    total_used_this_period: number;
    total_reserved_this_period: number;
  };
  queue: {
    depth: number;
    waiting: number;
    active: number;
    delayed: number;
  };
}

/**
 * Collects all admin metrics in a single pass.
 *
 * All database queries run in parallel. BullMQ queue counts are fetched
 * concurrently with the DB queries. Total wall time is dominated by the
 * slowest single query rather than the sum of all queries.
 *
 * Throws if the database is unreachable so the caller can surface the error
 * appropriately (503 from the HTTP handler, error log from the scheduler).
 */
export async function collectMetrics(): Promise<MetricsSnapshot> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    userTotal,
    userNew,
    subRows,
    analysisRows,
    creditRows,
    queueCounts,
  ] = await Promise.all([

    // Total users
    db.select({ count: sql<number>`cast(count(*) as integer)` })
      .from(schema.users)
      .then(([r]) => r.count),

    // New users last 7 days
    db.select({ count: sql<number>`cast(count(*) as integer)` })
      .from(schema.users)
      .where(gt(schema.users.createdAt, sevenDaysAgo))
      .then(([r]) => r.count),

    // Subscriptions grouped by (status, planId) for breakdown
    db.select({
      planId:  schema.subscriptions.planId,
      status:  schema.subscriptions.status,
      count:   sql<number>`cast(count(*) as integer)`,
    })
      .from(schema.subscriptions)
      .groupBy(schema.subscriptions.planId, schema.subscriptions.status),

    // Analyses grouped by status
    db.select({
      status: schema.analyses.status,
      count:  sql<number>`cast(count(*) as integer)`,
    })
      .from(schema.analyses)
      .groupBy(schema.analyses.status),

    // Aggregate credit usage across all active billing periods
    db.select({
      totalUsed:     sql<number>`cast(coalesce(sum(credits_used), 0) as integer)`,
      totalReserved: sql<number>`cast(coalesce(sum(credits_reserved), 0) as integer)`,
    })
      .from(schema.creditUsage)
      .then(([r]) => r),

    // BullMQ queue depth
    getAnalysisQueue()
      .getJobCounts("waiting", "active", "delayed")
      .catch(() => ({ waiting: 0, active: 0, delayed: 0 })),
  ]);

  // ── Subscription breakdown ─────────────────────────

  const byStatus: Record<string, number> = {};
  const activeByPlan: Record<string, number> = {};

  for (const row of subRows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
    if (row.status === "active") {
      activeByPlan[row.planId] = (activeByPlan[row.planId] ?? 0) + row.count;
    }
  }

  // ── Analysis breakdown ─────────────────────────────

  const analysisByStatus: Record<string, number> = {};
  for (const row of analysisRows) {
    analysisByStatus[row.status] = row.count;
  }

  const completed  = analysisByStatus["completed"]  ?? 0;
  const failed     = analysisByStatus["failed"]      ?? 0;
  const queued     = analysisByStatus["queued"]      ?? 0;
  const processing = analysisByStatus["processing"]  ?? 0;
  const total      = completed + failed + queued + processing;

  const terminalTotal = completed + failed;
  const failureRatePct = terminalTotal > 0
    ? Math.round((failed / terminalTotal) * 1_000) / 10
    : 0;

  // ── Queue counts ───────────────────────────────────

  const waiting = queueCounts.waiting  ?? 0;
  const active  = queueCounts.active   ?? 0;
  const delayed = queueCounts.delayed  ?? 0;

  return {
    generated_at: new Date().toISOString(),
    users: {
      total:       userTotal,
      new_last_7d: userNew,
    },
    subscriptions: {
      by_status:      byStatus,
      active_by_plan: activeByPlan,
    },
    analyses: {
      total,
      completed,
      failed,
      queued,
      processing,
      failure_rate_pct: failureRatePct,
    },
    credits: {
      total_used_this_period:     creditRows.totalUsed,
      total_reserved_this_period: creditRows.totalReserved,
    },
    queue: {
      depth:   waiting + active + delayed,
      waiting,
      active,
      delayed,
    },
  };
}

/* ── Periodic Metrics Logger ──────────────────────── */

/**
 * Emits the current metrics snapshot as a single structured log line.
 *
 * Designed to be consumed by log aggregation pipelines (Datadog, CloudWatch,
 * Loki, etc.) that index structured JSON. Each field is a first-class key so
 * alerting rules can target e.g. `failure_rate_pct > 10` directly.
 */
async function logMetricsSnapshot(): Promise<void> {
  try {
    const m = await collectMetrics();
    logger.info(
      {
        users_total:               m.users.total,
        users_new_7d:              m.users.new_last_7d,
        subs_active:               m.subscriptions.by_status["active"]    ?? 0,
        subs_cancelled:            m.subscriptions.by_status["cancelled"] ?? 0,
        subs_past_due:             m.subscriptions.by_status["past_due"]  ?? 0,
        analyses_total:            m.analyses.total,
        analyses_completed:        m.analyses.completed,
        analyses_failed:           m.analyses.failed,
        analyses_in_flight:        m.analyses.queued + m.analyses.processing,
        analyses_failure_rate_pct: m.analyses.failure_rate_pct,
        credits_used:              m.credits.total_used_this_period,
        credits_reserved:          m.credits.total_reserved_this_period,
        queue_depth:               m.queue.depth,
      },
      "metrics.snapshot"
    );
  } catch (err) {
    logger.error({ err }, "metrics.snapshot_failed");
  }
}

/**
 * Starts the periodic metrics logger.
 *
 * Fires one snapshot immediately (non-blocking) then repeats at the
 * configured interval. Pass the returned timer to `stopMetricsLogger` for
 * clean shutdown.
 *
 * If `config.admin.metricsIntervalMs` is 0, the scheduler is disabled and
 * null is returned.
 */
export function startMetricsLogger(): NodeJS.Timeout | null {
  const intervalMs = config.admin.metricsIntervalMs;
  if (intervalMs <= 0) return null;

  // Immediate first snapshot — fire and forget so startup isn't blocked.
  logMetricsSnapshot();

  return setInterval(logMetricsSnapshot, intervalMs);
}

export function stopMetricsLogger(timer: NodeJS.Timeout): void {
  clearInterval(timer);
}
