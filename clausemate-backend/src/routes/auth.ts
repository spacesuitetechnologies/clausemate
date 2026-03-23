import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { config } from "../config";
import * as schema from "../db/schema";
import { db } from "../db/client";
import { validate } from "../middleware/validate";
import { authRateLimit } from "../middleware/rateLimit";
import { blacklistToken } from "../services/tokenBlacklist";
import { sendVerificationEmail, sendPasswordResetEmail } from "../services/email";
import { isDisposableEmail } from "../services/emailValidation";
import type { JwtPayload } from "../types";
import { getPlan } from "../types";
import { logger } from "../services/logger";

const router = Router();

/* ── Cookie Config ────────────────────────────────── */

const COOKIE_NAME = "token";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: !config.isDev, // HTTPS only in production
  sameSite: "strict" as const,
  maxAge: 24 * 60 * 60 * 1000, // 24h in ms (matches JWT expiry)
  path: "/",
};

/* ── Schemas ──────────────────────────────────────── */

const signupSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1, "Name is required").max(100),
});

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

/* ── Token Generation ─────────────────────────────── */

function generateToken(userId: string, email: string): string {
  const payload: Omit<JwtPayload, "exp"> = {
    jti: uuidv4(),
    userId,
    email,
  };
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiry,
  } as jwt.SignOptions);
}

/* ── Verification / Reset Token Helpers ──────────── */

/**
 * Generates a cryptographically secure URL-safe token.
 * Returns the raw token (for the email link) and its SHA-256 hash (for storage).
 * Only the hash is persisted — the raw token is never written to the database.
 */
function generateSecureToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/* ── POST /auth/signup ────────────────────────────── */

router.post(
  "/signup",
  authRateLimit,
  validate(signupSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { email, password, name } = req.body;
      const normalizedEmail = email.toLowerCase();

      // Reject disposable / temporary email addresses before touching the DB.
      if (isDisposableEmail(normalizedEmail)) {
        req.log.warn({ email: normalizedEmail }, "signup.disposable_email_rejected");
        res.status(400).json({
          error: "Disposable or temporary email addresses are not allowed. Please use a permanent email address.",
        });
        return;
      }

      // Check existing user
      const [existing] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, normalizedEmail))
        .limit(1);

      if (existing) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // Generate email verification token.
      // If SMTP is not configured, mark the email as already verified so
      // users are not locked out in environments without an email service.
      const smtpEnabled = Boolean(config.smtp.host);
      const { raw: verificationRaw, hash: verificationHash } = generateSecureToken();

      // Create user, subscription, and credit usage atomically.
      // Without a transaction, a crash between any two inserts leaves the
      // user in a broken state: existing but with no subscription (causes
      // 500 on every subsequent request) or with no credit_usage row.
      const freePlan = getPlan("free");
      const now = new Date();
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      const { user } = await db.transaction(async (tx) => {
        const [newUser] = await tx
          .insert(schema.users)
          .values({
            email: normalizedEmail,
            passwordHash,
            name,
            emailVerified: !smtpEnabled, // auto-verified when no SMTP
            emailVerificationToken: smtpEnabled ? verificationHash : null,
            emailVerificationSentAt: smtpEnabled ? new Date() : null,
          })
          .returning();

        const [newSubscription] = await tx
          .insert(schema.subscriptions)
          .values({
            userId: newUser.id,
            planId: "free",
            status: "active",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          })
          .returning();

        await tx.insert(schema.creditUsage).values({
          userId: newUser.id,
          subscriptionId: newSubscription.id,
          creditsUsed: 0,
          creditsRemaining: freePlan.credits,
          overageCredits: 0,
          overageCost: "0",
          periodStart: now,
          periodEnd: periodEnd,
        });

        return { user: newUser };
      });

      // Send verification email (non-blocking — a send failure must not
      // prevent the user from completing signup).
      if (smtpEnabled) {
        sendVerificationEmail(normalizedEmail, name, verificationRaw).catch((err) =>
          req.log.error({ email: normalizedEmail, err }, "email.verification_send_failed")
        );
      }

      const token = generateToken(user.id, user.email);
      res.cookie(COOKIE_NAME, token, COOKIE_OPTS);

      res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          email_verified: user.emailVerified,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, "Signup error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* ── POST /auth/login ─────────────────────────────── */

router.post(
  "/login",
  authRateLimit,
  validate(loginSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { email, password } = req.body;

      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1);

      if (!user) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const passwordMatch = await bcrypt.compare(password, user.passwordHash);
      if (!passwordMatch) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const token = generateToken(user.id, user.email);
      res.cookie(COOKIE_NAME, token, COOKIE_OPTS);

      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          email_verified: user.emailVerified,
        },
      });
    } catch (error) {
      req.log.error({ err: error }, "Login error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* ── POST /auth/logout ────────────────────────────── */

router.post("/logout", async (req: Request, res: Response): Promise<void> => {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;

  if (token) {
    try {
      // Verify to extract jti and exp — ignore expiry errors so an
      // already-expired cookie still gets cleared cleanly.
      const decoded = jwt.verify(token, config.jwt.secret, {
        ignoreExpiration: false,
      }) as JwtPayload;

      if (decoded.jti && decoded.exp) {
        await blacklistToken(decoded.jti, decoded.exp);
      }
    } catch {
      // Invalid token — still clear the cookie below
    }
  }

  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ success: true });
});

/* ── GET /auth/verify-email ───────────────────────── */
// Token arrives as a query param in the link sent by email.
// We hash it before the DB lookup so the raw token is never compared directly.

const verifyEmailSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

router.get(
  "/verify-email",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = verifyEmailSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid or missing verification token." });
        return;
      }

      const tokenHash = crypto
        .createHash("sha256")
        .update(parsed.data.token)
        .digest("hex");

      const [user] = await db
        .select({ id: schema.users.id, emailVerified: schema.users.emailVerified, emailVerificationSentAt: schema.users.emailVerificationSentAt })
        .from(schema.users)
        .where(eq(schema.users.emailVerificationToken, tokenHash))
        .limit(1);

      if (!user) {
        res.status(400).json({ error: "Invalid or expired verification token." });
        return;
      }

      if (user.emailVerified) {
        res.json({ message: "Email already verified." });
        return;
      }

      // Token expires 24 hours after it was sent
      const sentAt = user.emailVerificationSentAt;
      if (sentAt) {
        const expiresAt = new Date(sentAt.getTime() + 24 * 60 * 60 * 1000);
        if (new Date() > expiresAt) {
          res.status(400).json({
            error: "Verification link has expired. Please request a new one.",
            code: "TOKEN_EXPIRED",
          });
          return;
        }
      }

      await db
        .update(schema.users)
        .set({
          emailVerified: true,
          emailVerificationToken: null,
          emailVerificationSentAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, user.id));

      logger.info({ userId: user.id }, "auth.email_verified");
      res.json({ message: "Email verified successfully." });
    } catch (error) {
      req.log.error({ err: error }, "Verify email error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* ── POST /auth/resend-verification ──────────────── */
// Rate-limited. Accepts the email address (no auth cookie required —
// the user may not be logged in on the device they are checking email on).

const resendSchema = z.object({
  email: z.string().email("Invalid email address"),
});

router.post(
  "/resend-verification",
  authRateLimit,
  validate(resendSchema),
  async (req: Request, res: Response): Promise<void> => {
    // Always respond with 200 regardless of whether the email exists, to
    // prevent email enumeration attacks.
    const SAFE_RESPONSE = { message: "If that address is registered and unverified, a new link has been sent." };

    try {
      const { email } = req.body as { email: string };
      const normalizedEmail = email.toLowerCase();

      const [user] = await db
        .select({
          id: schema.users.id,
          name: schema.users.name,
          emailVerified: schema.users.emailVerified,
          emailVerificationSentAt: schema.users.emailVerificationSentAt,
        })
        .from(schema.users)
        .where(eq(schema.users.email, normalizedEmail))
        .limit(1);

      if (!user || user.emailVerified) {
        res.json(SAFE_RESPONSE);
        return;
      }

      // Throttle resends: at most one every 5 minutes
      if (user.emailVerificationSentAt) {
        const cooldownMs = 5 * 60 * 1000;
        const nextAllowed = new Date(user.emailVerificationSentAt.getTime() + cooldownMs);
        if (new Date() < nextAllowed) {
          res.json(SAFE_RESPONSE);
          return;
        }
      }

      const { raw, hash } = generateSecureToken();
      await db
        .update(schema.users)
        .set({
          emailVerificationToken: hash,
          emailVerificationSentAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, user.id));

      sendVerificationEmail(normalizedEmail, user.name, raw).catch((err) =>
        req.log.error({ email: normalizedEmail, err }, "email.reverification_send_failed")
      );

      res.json(SAFE_RESPONSE);
    } catch (error) {
      req.log.error({ err: error }, "Resend verification error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* ── POST /auth/forgot-password ───────────────────── */

const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

router.post(
  "/forgot-password",
  authRateLimit,
  validate(forgotPasswordSchema),
  async (req: Request, res: Response): Promise<void> => {
    // Always 200 — never reveal whether the email is registered.
    const SAFE_RESPONSE = { message: "If that email is registered, a password reset link has been sent." };

    try {
      const { email } = req.body as { email: string };
      const normalizedEmail = email.toLowerCase();

      const [user] = await db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.email, normalizedEmail))
        .limit(1);

      if (!user) {
        res.json(SAFE_RESPONSE);
        return;
      }

      const { raw, hash } = generateSecureToken();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db
        .update(schema.users)
        .set({
          passwordResetToken: hash,
          passwordResetExpiresAt: expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, user.id));

      sendPasswordResetEmail(normalizedEmail, user.name, raw).catch((err) =>
        req.log.error({ email: normalizedEmail, err }, "email.password_reset_send_failed")
      );

      logger.info({ userId: user.id }, "auth.password_reset_requested");
      res.json(SAFE_RESPONSE);
    } catch (error) {
      req.log.error({ err: error }, "Forgot password error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* ── POST /auth/reset-password ────────────────────── */

const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

router.post(
  "/reset-password",
  authRateLimit,
  validate(resetPasswordSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { token, password } = req.body as { token: string; password: string };

      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const [user] = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          passwordResetExpiresAt: schema.users.passwordResetExpiresAt,
        })
        .from(schema.users)
        .where(eq(schema.users.passwordResetToken, tokenHash))
        .limit(1);

      if (!user) {
        res.status(400).json({ error: "Invalid or expired password reset token." });
        return;
      }

      if (!user.passwordResetExpiresAt || new Date() > user.passwordResetExpiresAt) {
        res.status(400).json({
          error: "Password reset link has expired. Please request a new one.",
          code: "TOKEN_EXPIRED",
        });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 12);

      await db
        .update(schema.users)
        .set({
          passwordHash,
          passwordResetToken: null,
          passwordResetExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, user.id));

      logger.info({ userId: user.id }, "auth.password_reset_completed");

      // Clear the session cookie so all existing sessions are invalidated.
      // The user must log in again with the new password.
      res.clearCookie(COOKIE_NAME, { path: "/" });
      res.json({ message: "Password reset successfully. Please log in with your new password." });
    } catch (error) {
      req.log.error({ err: error }, "Reset password error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
