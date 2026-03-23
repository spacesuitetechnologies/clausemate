import { Queue, Worker, type Job } from "bullmq";
import { config } from "../config";

/* ── Redis Connection Options ─────────────────────── */

export function getRedisConnectionOpts() {
  // Parse the Redis URL into host/port/password for BullMQ
  const url = new URL(config.redis.url);
  return {
    host: url.hostname || "localhost",
    port: parseInt(url.port || "6379", 10),
    password: url.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}

/* ── Analysis Queue ───────────────────────────────── */

let analysisQueue: Queue | null = null;

export interface AnalysisJobData {
  analysisId: string;
  contractId: string;
  userId: string;
  storagePath: string;
  mimeType: string;
  includeRedlines: boolean;
  pageCount: number;
  // Amount reserved at queue time — used by the worker to finalize or
  // release the reservation without re-querying the analyses table.
  creditsEstimated: number;
  // Subscription that was active when the reservation was made.
  // Passed to finalizeCredits / releaseReservation so they target the
  // correct row even if the user upgrades between queue time and completion.
  subscriptionId: string;
  // Primary key of the credit_reservations row created at queue time.
  // Used as the idempotency key for all state transitions so that
  // retried or duplicated worker calls cannot double-deduct or double-release.
  reservationId: string;
}

export function getAnalysisQueue(): Queue<AnalysisJobData> {
  if (!analysisQueue) {
    analysisQueue = new Queue<AnalysisJobData>("contract-analysis", {
      connection: getRedisConnectionOpts(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 500 },
      },
    });
  }
  return analysisQueue as Queue<AnalysisJobData>;
}

/* ── Queue Capacity Check ─────────────────────────── */

/**
 * Returns whether the queue has room for a new job.
 *
 * Counts waiting + active + delayed jobs. Delayed jobs are included
 * because they will become waiting once their delay expires and still
 * consume queue capacity. Completed and failed jobs are excluded —
 * they are already resolved and do not represent in-flight load.
 *
 * Called before reserving credits so a capacity rejection never
 * touches the credit ledger.
 */
export async function checkQueueCapacity(): Promise<{
  available: boolean;
  depth: number;
}> {
  const queue = getAnalysisQueue();
  const counts = await queue.getJobCounts("waiting", "active", "delayed");
  const depth = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  return { available: depth < config.analysis.maxQueueDepth, depth };
}

/* ── Graceful Shutdown ────────────────────────────── */

export async function closeQueues(): Promise<void> {
  if (analysisQueue) {
    await analysisQueue.close();
    analysisQueue = null;
  }
}
