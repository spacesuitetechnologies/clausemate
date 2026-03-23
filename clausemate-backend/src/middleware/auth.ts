import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { isBlacklisted } from "../services/tokenBlacklist";
import type { JwtPayload } from "../types";

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.cookies?.token as string | undefined;

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // Reject tokens that have been explicitly revoked via logout
  if (decoded.jti && (await isBlacklisted(decoded.jti))) {
    res.status(401).json({ error: "Token has been revoked" });
    return;
  }

  req.userId = decoded.userId;
  req.userEmail = decoded.email;
  next();
}
