import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { v4 as uuidv4 } from "uuid";
import { config } from "./config";
import { logger } from "./services/logger";
import { generalRateLimit } from "./middleware/rateLimit";
import authRoutes from "./routes/auth";
import userRoutes from "./routes/user";
import contractRoutes from "./routes/contracts";
import analysisRoutes from "./routes/analysis";
import billingRoutes from "./routes/billing";
import webhookRoutes from "./routes/webhook";
import { startAnalysisWorker, stopAnalysisWorker } from "./workers/analysisWorker";
import { closeQueues } from "./workers/queue";
import { closeDb, validateMigrations } from "./db/client";
import { closeRateLimitRedis } from "./middleware/rateLimit";
import { closeBlacklistRedis } from "./services/tokenBlacklist";
import { validateStorageConfig } from "./services/storage";
import { startCleanupScheduler, stopCleanupScheduler } from "./services/fileCleanup";
import { startMetricsLogger, stopMetricsLogger } from "./services/adminMetrics";
import { checkRedisAof } from "./services/redisCheck";
import { startStaleReservationSweeper, stopStaleReservationSweeper } from "./services/staleReservationSweeper";
import { startSubscriptionReconciler, stopSubscriptionReconciler } from "./services/subscriptionReconciler";
import adminRoutes from "./routes/admin";

/* ── App Setup ────────────────────────────────────── */

const app = express();

// Global middleware
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(cookieParser());
app.use(
  pinoHttp({
    logger,
    // Honour an upstream request ID if present; otherwise generate one.
    // req.id and req.log bindings carry this ID into every log line.
    genReqId: (req) => (req.headers["x-request-id"] as string) ?? uuidv4(),
    // Suppress noise for the health-check endpoint.
    autoLogging: { ignore: (req) => req.url === "/health" },
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  })
);

// Propagate the request ID to responses so clients and load-balancers can
// correlate their logs with ours without parsing JSON log lines.
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader("x-request-id", req.id as string);
  next();
});

// Webhook route MUST use raw body parser (before express.json) for signature verification
app.use("/api/webhook", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(generalRateLimit);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/contracts", contractRoutes);
app.use("/api/analyze", analysisRoutes);
app.use("/api/analysis", analysisRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/webhook", webhookRoutes);

// Admin routes — separate prefix, protected by adminAuthMiddleware internally.
// Not under /api/ to keep the admin surface clearly distinct from user-facing routes.
app.use("/admin", adminRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    req.log.error({ err }, "Unhandled error");
    res.status(500).json({ error: "Internal server error" });
  }
);

/* ── Startup & Graceful Shutdown ──────────────────── */

async function shutdown(
  signal: string,
  server: import("http").Server,
  workerStarted: boolean,
  cleanupTimer: NodeJS.Timeout | null,
  metricsTimer: NodeJS.Timeout | null,
  sweeperTimer: NodeJS.Timeout | null,
  reconcilerTimer: NodeJS.Timeout | null
) {
  logger.info({ signal }, "shutdown_initiated");

  server.close(async () => {
    logger.info("HTTP server closed");

    try {
      if (metricsTimer) stopMetricsLogger(metricsTimer);
      if (cleanupTimer) stopCleanupScheduler(cleanupTimer);
      if (sweeperTimer) stopStaleReservationSweeper(sweeperTimer);
      if (reconcilerTimer) stopSubscriptionReconciler(reconcilerTimer);
      if (workerStarted) {
        await stopAnalysisWorker();
      }
      await closeQueues();
      await closeRateLimitRedis();
      await closeBlacklistRedis();
      await closeDb();
      logger.info("Workers, queues, Redis, and DB closed");
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
    }

    process.exit(0);
  });

  // Force shutdown after 10s
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

(async () => {
  // Confirm migrations have been applied before accepting any traffic.
  // Throws if the __drizzle_migrations journal is absent or empty, so a
  // fresh deployment never serves against an un-migrated schema.
  await validateMigrations();

  // Validate storage config before accepting any traffic.
  // Throws immediately if STORAGE_TYPE=s3 (not implemented) or if the
  // local storage path is not writable — prevents silent data loss.
  await validateStorageConfig();

  // Check Redis AOF persistence. Logs CRITICAL if disabled but does not
  // crash — the warning surfaces in logs/alerting for ops to act on.
  await checkRedisAof();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, "clausemate-backend started");
  });

  // Start BullMQ worker
  let workerStarted = false;
  try {
    startAnalysisWorker();
    workerStarted = true;
  } catch (err) {
    logger.warn({ err }, "Could not start analysis worker — jobs will queue until worker starts");
  }

  // Start orphan file cleanup scheduler (runs once immediately, then daily).
  const cleanupTimer = startCleanupScheduler();

  // Start periodic metrics logger (runs once immediately, then hourly by default).
  const metricsTimer = startMetricsLogger();

  // Start stale credit-reservation sweeper (runs once immediately, then hourly).
  // Releases credits for any reservations orphaned by a Redis restart or job loss.
  const sweeperTimer = startStaleReservationSweeper();

  // Start subscription reconciler (runs once immediately, then every 15 min).
  // Activates subscriptions and allocates credits when the Razorpay webhook was
  // not delivered (network failure, server downtime during checkout completion).
  const reconcilerTimer = startSubscriptionReconciler();

  process.on("SIGTERM", () => shutdown("SIGTERM", server, workerStarted, cleanupTimer, metricsTimer, sweeperTimer, reconcilerTimer));
  process.on("SIGINT",  () => shutdown("SIGINT",  server, workerStarted, cleanupTimer, metricsTimer, sweeperTimer, reconcilerTimer));
})().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});

export default app;
