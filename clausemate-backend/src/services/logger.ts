import pino from "pino";

/**
 * Shared logger instance for the entire process.
 *
 * In development: pretty-printed output (requires pino-pretty if installed,
 * falls back to JSON if not). In production: JSON to stdout — pipe to a
 * log aggregator (Datadog, Loki, CloudWatch, etc.).
 *
 * Child loggers carry all parent bindings, so request-scoped context
 * (requestId, userId) flows automatically into every log line emitted
 * from within that request.
 */
const isDev = (process.env.NODE_ENV ?? "development") === "development";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
    },
  }),
});
