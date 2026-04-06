/**
 * Structured logger for server-side code.
 * Outputs JSON to stdout/stderr — compatible with Vercel log drains,
 * Datadog, Logtail, and any structured logging aggregator.
 *
 * Usage:
 *   import { log, warn, err } from "./logger";
 *   log("extract", "OCR triggered", { contractId, fileHash });
 */

type LogLevel = "info" | "warn" | "error";

export interface LogData {
  [key: string]: unknown;
}

function emit(level: LogLevel, service: string, msg: string, data?: LogData): void {
  const entry = {
    level,
    service,
    msg,
    ts: new Date().toISOString(),
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    ...data,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log  = (service: string, msg: string, data?: LogData) => emit("info",  service, msg, data);
export const warn = (service: string, msg: string, data?: LogData) => emit("warn",  service, msg, data);
export const err  = (service: string, msg: string, data?: LogData) => emit("error", service, msg, data);
