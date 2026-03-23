import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config } from "../config";
import { logger } from "./logger";

/* ── Transport ────────────────────────────────────── */

let _transport: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!config.smtp.host) return null;

  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      // Port 465 uses implicit TLS; others use STARTTLS
      secure: config.smtp.port === 465,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
    });
  }
  return _transport;
}

/* ── Dev Fallback ─────────────────────────────────── */

/**
 * When SMTP is not configured, log the email content so developers can
 * copy the link from the terminal without needing a mail server.
 *
 * This is intentionally only reachable when SMTP_HOST is unset — the check
 * happens in every send function, not here.
 */
function logEmailFallback(to: string, subject: string, text: string): void {
  logger.info({ to, subject, body: text }, "email.dev_fallback (SMTP not configured — link logged above)");
}

/* ── Verification Email ───────────────────────────── */

/**
 * Sends the email verification link.
 *
 * @param token  Raw (unhashed) token to embed in the link — never store this.
 */
export async function sendVerificationEmail(
  email: string,
  name: string,
  token: string
): Promise<void> {
  const link = `${config.appUrl}/verify-email?token=${token}`;
  const subject = "Verify your Clausemate email address";

  const text = [
    `Hi ${name},`,
    "",
    "Please verify your email address by clicking the link below.",
    "This link expires in 24 hours.",
    "",
    link,
    "",
    "If you did not create a Clausemate account, you can safely ignore this email.",
  ].join("\n");

  const html = `
<p>Hi ${escHtml(name)},</p>
<p>Please verify your email address by clicking the button below.
   This link expires in <strong>24 hours</strong>.</p>
<p>
  <a href="${escHtml(link)}" style="
    display:inline-block;padding:10px 20px;
    background:#2563eb;color:#fff;border-radius:6px;
    text-decoration:none;font-weight:600;">
    Verify Email Address
  </a>
</p>
<p>Or copy this link into your browser:<br>
   <small>${escHtml(link)}</small></p>
<p style="color:#6b7280;font-size:12px;">
  If you did not create a Clausemate account, you can safely ignore this email.
</p>`;

  const transport = getTransport();
  if (!transport) {
    logEmailFallback(email, subject, `Verification link: ${link}`);
    return;
  }

  await transport.sendMail({ from: config.smtp.from, to: email, subject, text, html });
  logger.info({ email }, "email.verification_sent");
}

/* ── Password Reset Email ─────────────────────────── */

/**
 * Sends the password reset link.
 *
 * @param token  Raw (unhashed) token — expires in 1 hour.
 */
export async function sendPasswordResetEmail(
  email: string,
  name: string,
  token: string
): Promise<void> {
  const link = `${config.appUrl}/reset-password?token=${token}`;
  const subject = "Reset your Clausemate password";

  const text = [
    `Hi ${name},`,
    "",
    "We received a request to reset your Clausemate password.",
    "Click the link below to choose a new password. This link expires in 1 hour.",
    "",
    link,
    "",
    "If you did not request a password reset, you can safely ignore this email.",
    "Your password will not be changed.",
  ].join("\n");

  const html = `
<p>Hi ${escHtml(name)},</p>
<p>We received a request to reset your Clausemate password.
   Click the button below to choose a new password.
   This link expires in <strong>1 hour</strong>.</p>
<p>
  <a href="${escHtml(link)}" style="
    display:inline-block;padding:10px 20px;
    background:#2563eb;color:#fff;border-radius:6px;
    text-decoration:none;font-weight:600;">
    Reset Password
  </a>
</p>
<p>Or copy this link into your browser:<br>
   <small>${escHtml(link)}</small></p>
<p style="color:#6b7280;font-size:12px;">
  If you did not request a password reset, you can safely ignore this email.
  Your password will not be changed.
</p>`;

  const transport = getTransport();
  if (!transport) {
    logEmailFallback(email, subject, `Password reset link: ${link}`);
    return;
  }

  await transport.sendMail({ from: config.smtp.from, to: email, subject, text, html });
  logger.info({ email }, "email.password_reset_sent");
}

/* ── HTML Escaping ────────────────────────────────── */

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
