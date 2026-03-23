import { Request, Response, NextFunction } from "express";
import { config } from "../config";

/**
 * Protects admin routes with a static API key.
 *
 * If ADMIN_API_KEY is not set, admin routes respond 503 (disabled) rather
 * than 401, so an unconfigured deployment does not accidentally expose an
 * unauthenticated admin surface.
 *
 * The key is read from the Authorization header: "Bearer <key>".
 */
export function adminAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!config.admin.apiKey) {
    res.status(503).json({ error: "Admin interface is not enabled on this instance." });
    return;
  }

  const authHeader = req.headers.authorization;
  const key = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  if (!key || key !== config.admin.apiKey) {
    res.status(401).json({ error: "Invalid or missing admin API key." });
    return;
  }

  next();
}
