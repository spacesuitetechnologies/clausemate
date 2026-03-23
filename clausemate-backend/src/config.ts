import dotenv from "dotenv";

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function requiredSecret(key: string, minLength: number): string {
  const value = required(key);
  if (value.length < minLength) {
    throw new Error(
      `${key} must be at least ${minLength} characters long ` +
      `(got ${value.length}). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  const isDev = (process.env.NODE_ENV ?? "development") === "development";
  if (!isDev) {
    const weak = ["secret", "changeme", "password", "jwt_secret", "dev", "test"];
    if (weak.some((w) => value.toLowerCase().includes(w))) {
      throw new Error(
        `${key} looks like a weak or default value. Set a securely generated secret for production.`
      );
    }
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  port: parseInt(optional("PORT", "3001"), 10),
  nodeEnv: optional("NODE_ENV", "development"),
  isDev: optional("NODE_ENV", "development") === "development",

  database: {
    url: required("DATABASE_URL"),
  },

  redis: {
    url: optional("REDIS_URL", "redis://localhost:6379"),
  },

  jwt: {
    secret: requiredSecret("JWT_SECRET", 32),
    expiry: optional("JWT_EXPIRY", "24h"),
  },

  llm: {
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    primaryProvider: optional("LLM_PRIMARY_PROVIDER", "openai") as "openai" | "anthropic",
    fallbackProvider: optional("LLM_FALLBACK_PROVIDER", "anthropic") as "openai" | "anthropic",
    modelOpenai: optional("LLM_MODEL_OPENAI", "gpt-4o"),
    modelAnthropic: optional("LLM_MODEL_ANTHROPIC", "claude-sonnet-4-20250514"),
    // Hard ceiling on estimated input tokens for a single analysis.
    // Prevents runaway cost from unusually large contracts. ~80k tokens ≈ 320k chars.
    maxInputTokens: parseInt(optional("LLM_MAX_INPUT_TOKENS", "80000"), 10),
    // Monthly LLM token ceiling per user (input + output combined).
    // Protects against a single user exhausting API quota.
    maxMonthlyTokensPerUser: parseInt(optional("LLM_MAX_MONTHLY_TOKENS_PER_USER", "5000000"), 10),
  },

  storage: {
    type: optional("STORAGE_TYPE", "local") as "local" | "s3",
    localPath: optional("STORAGE_LOCAL_PATH", "./uploads"),
    // Uploaded contracts with no analysis that are older than this many days
    // are considered abandoned and removed from storage + the database.
    orphanRetentionDays: parseInt(optional("STORAGE_ORPHAN_RETENTION_DAYS", "30"), 10),
    s3: {
      bucket: optional("S3_BUCKET", ""),
      region: optional("S3_REGION", "ap-south-1"),
      accessKey: optional("S3_ACCESS_KEY", ""),
      secretKey: optional("S3_SECRET_KEY", ""),
      endpoint: optional("S3_ENDPOINT", ""),
    },
  },

  rateLimit: {
    auth: {
      max: parseInt(optional("RATE_LIMIT_AUTH_MAX", "100"), 10),
      windowMs: parseInt(optional("RATE_LIMIT_AUTH_WINDOW_MS", "60000"), 10),
    },
    analysis: {
      max: parseInt(optional("RATE_LIMIT_ANALYSIS_MAX", "10"), 10),
      windowMs: parseInt(optional("RATE_LIMIT_ANALYSIS_WINDOW_MS", "60000"), 10),
    },
  },

  analysis: {
    // Maximum analyses a single user may have in queued|processing state at once.
    // Prevents one user from flooding the queue and starving others.
    maxConcurrentPerUser: parseInt(optional("ANALYSIS_MAX_CONCURRENT_PER_USER", "3"), 10),
    // Maximum total jobs (waiting + active + delayed) allowed in the BullMQ queue.
    // New submissions are rejected with 503 when this ceiling is reached.
    maxQueueDepth: parseInt(optional("ANALYSIS_MAX_QUEUE_DEPTH", "100"), 10),
    // BullMQ worker concurrency — how many jobs run in parallel per process.
    workerConcurrency: parseInt(optional("ANALYSIS_WORKER_CONCURRENCY", "3"), 10),
    // BullMQ rate limiter — max jobs the worker starts within limiterWindowMs.
    // Directly bounds the LLM call rate: workerLimiterMax LLM calls per window.
    workerLimiterMax: parseInt(optional("ANALYSIS_WORKER_LIMITER_MAX", "10"), 10),
    workerLimiterWindowMs: parseInt(optional("ANALYSIS_WORKER_LIMITER_WINDOW_MS", "60000"), 10),
    // Hard wall-clock timeout for a single job execution attempt.
    // If processAnalysis does not complete within this window the job is
    // forcibly failed, credits are released, and BullMQ schedules a retry.
    // Must be larger than the expected worst-case runtime (many clauses ×
    // LLM latency × retries).  Default: 20 minutes.
    jobTimeoutMs: parseInt(optional("ANALYSIS_JOB_TIMEOUT_MS", String(20 * 60 * 1000)), 10),
    // How long (ms) the worker holds the BullMQ distributed lock on each job
    // before the heartbeat must renew it.  If the worker process dies without
    // renewing, the job is moved back to waiting after ~lockDuration.
    // Default: 5 minutes — short enough for fast crash recovery, long enough
    // for the heartbeat (fires at lockDuration / 2) to comfortably renew.
    workerLockDurationMs: parseInt(optional("ANALYSIS_WORKER_LOCK_DURATION_MS", String(5 * 60 * 1000)), 10),
    // How often (ms) BullMQ scans for stalled jobs across all worker processes.
    // Default: 60 seconds.
    workerStalledIntervalMs: parseInt(optional("ANALYSIS_WORKER_STALLED_INTERVAL_MS", "60000"), 10),
    // Maximum number of times a job may stall (lock expired without renewal)
    // before BullMQ permanently fails it.  Allows for brief process pauses
    // (e.g. GC) while catching genuine hangs.  Default: 2.
    workerMaxStalledCount: parseInt(optional("ANALYSIS_WORKER_MAX_STALLED_COUNT", "2"), 10),
    // How often (ms) the stale reservation sweeper runs.
    // The sweeper releases credit_reservations stuck in "reserved" state after
    // a Redis restart and marks orphaned "processing" analyses as failed.
    // Default: every hour.
    staleReservationSweepIntervalMs: parseInt(optional("ANALYSIS_STALE_SWEEP_INTERVAL_MS", "3600000"), 10),
    // A credit_reservation is considered stale when its age exceeds this value.
    // Formula: jobTimeoutMs × maxAttempts × safetyMultiplier
    // Default: 20 min × 3 attempts × 2× safety = 7 200 000 ms (2 hours).
    // After this window every possible BullMQ retry has expired, so any
    // remaining "reserved" reservation was orphaned by a lost job.
    staleReservationCutoffMs: parseInt(optional("ANALYSIS_STALE_RESERVATION_CUTOFF_MS", String(20 * 60 * 1000 * 3 * 2)), 10),
  },

  admin: {
    // Set ADMIN_API_KEY to a long random string to enable admin endpoints.
    // Leave empty (the default) to disable admin routes entirely on this instance.
    apiKey: optional("ADMIN_API_KEY", ""),
    // How often (ms) to emit a structured metrics snapshot to the log.
    // Default: every hour. Set to 0 to disable periodic metric logging.
    metricsIntervalMs: parseInt(optional("ADMIN_METRICS_INTERVAL_MS", "3600000"), 10),
  },

  // Base URL of the frontend app — used to build links in emails.
  appUrl: optional("APP_URL", "http://localhost:5173"),

  smtp: {
    host: optional("SMTP_HOST", ""),
    port: parseInt(optional("SMTP_PORT", "587"), 10),
    user: optional("SMTP_USER", ""),
    pass: optional("SMTP_PASS", ""),
    from: optional("SMTP_FROM", "noreply@clausemate.com"),
  },

  auth: {
    // Extra disposable/blocked email domains beyond the built-in list.
    // Comma-separated, e.g. "acme.example,trash.test"
    blockedEmailDomains: optional("BLOCKED_EMAIL_DOMAINS", ""),
  },

  corsOrigin: optional("CORS_ORIGIN", "http://localhost:5173"),

  maxFileSizeMb: parseInt(optional("MAX_FILE_SIZE_MB", "10"), 10),

  razorpay: {
    keyId: optional("RAZORPAY_KEY_ID", ""),
    keySecret: optional("RAZORPAY_KEY_SECRET", ""),
    webhookSecret: optional("RAZORPAY_WEBHOOK_SECRET", ""),
    planIds: {
      starter: optional("RAZORPAY_PLAN_ID_STARTER", ""),
      professional: optional("RAZORPAY_PLAN_ID_PROFESSIONAL", ""),
      enterprise: optional("RAZORPAY_PLAN_ID_ENTERPRISE", ""),
    },
  },
} as const;
