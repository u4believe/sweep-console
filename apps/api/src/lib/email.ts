import nodemailer from "nodemailer";
import { setDefaultResultOrder } from "node:dns";

// Many hosts (e.g. Railway) can't route IPv6 outbound, which surfaces as
// `connect ENETUNREACH <ipv6>:587` on SMTP. Prefer IPv4 for all DNS lookups.
setDefaultResultOrder("ipv4first");

interface SendOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function fromAddress(): string {
  return (
    process.env.EMAIL_FROM ??
    process.env.SMTP_FROM ??
    "Sweep Console <noreply@sweepconsole.com>"
  );
}

// Preferred transport: Resend's HTTP API (port 443). Works on hosts like Railway
// that block outbound SMTP ports (25/465/587), where nodemailer can't connect.
async function sendViaResend(opts: SendOptions): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY!;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend API ${res.status}: ${detail.slice(0, 300)}`);
  }
  console.log("[email] Sent to", opts.to, "via Resend");
}

function getTransport() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;

  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    // Fail fast instead of hanging when the connection can't be established.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendEmail(opts: SendOptions): Promise<void> {
  // 1) Prefer the HTTP API when configured — the only thing that reliably works
  //    on hosts that block outbound SMTP.
  if (process.env.RESEND_API_KEY) {
    try {
      await sendViaResend(opts);
      return;
    } catch (e) {
      console.error("[email] Resend error:", e);
      throw new Error(`Failed to send email: ${(e as Error).message}`);
    }
  }

  // 2) Fall back to SMTP (works locally / on hosts that allow it).
  const transport = getTransport();
  if (transport) {
    try {
      await transport.sendMail({ from: fromAddress(), ...opts });
      console.log("[email] Sent to", opts.to, "via SMTP");
      return;
    } catch (e) {
      console.error("[email] SMTP error:", e);
      throw new Error(`Failed to send email: ${(e as Error).message}`);
    }
  }

  // 3) Neither configured — log so local dev still surfaces the content.
  console.log("\n─────────────────────────────────────────");
  console.log("[email] No RESEND_API_KEY or SMTP_HOST set — logging instead of sending");
  console.log("[email] To:", opts.to);
  console.log("[email] Subject:", opts.subject);
  console.log("[email] Body:", opts.text);
  console.log("─────────────────────────────────────────\n");
}

export function otpEmailHtml(code: string, merchantName: string): string {
  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f9fafb;padding:40px 0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb">
    <h1 style="font-size:24px;font-weight:700;color:#111827;margin:0 0 8px">Confirm your email</h1>
    <p style="color:#6b7280;margin:0 0 24px">Enter this code to confirm your email and complete your subscription with ${merchantName}.</p>
    <div style="font-size:34px;font-weight:700;letter-spacing:8px;color:#111827;background:#f3f4f6;border-radius:8px;padding:18px;text-align:center">${code}</div>
    <p style="color:#9ca3af;font-size:12px;margin:24px 0 0">This code expires in 10 minutes. If you didn't request it, ignore this email.</p>
  </div>
</body>
</html>`;
}

/// Sent ONCE when a creator closes (deletes) a plan. Trust-first: we've already
/// stopped billing and returned any escrowed funds on-chain, so this is a receipt,
/// not a request. Revoking the dormant permission is optional.
export function planClosedEmailHtml(opts: {
  merchantName: string;
  planName: string;
  subscriptionId: string;
  refundTx?: string | null;
  refundAmount?: string | null; // human-readable, e.g. "9.00 USDC"
}): string {
  const refundLine =
    opts.refundTx && opts.refundAmount
      ? `<p style="color:#6b7280;margin:0 0 16px">We returned <strong>${opts.refundAmount}</strong> that was still held in escrow to your wallet — on-chain proof: <span style="font-family:monospace;font-size:12px;color:#374151">${opts.refundTx}</span>.</p>`
      : `<p style="color:#6b7280;margin:0 0 16px">Nothing was held in escrow, so there was nothing to return.</p>`;
  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f9fafb;padding:40px 0">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb">
    <h1 style="font-size:22px;font-weight:700;color:#111827;margin:0 0 8px">Your ${opts.planName} subscription has ended</h1>
    <p style="color:#6b7280;margin:0 0 16px">${opts.merchantName} closed this plan, so we cancelled your subscription (${opts.subscriptionId}). <strong>We stopped billing the moment it was closed and will never charge it again.</strong></p>
    ${refundLine}
    <p style="color:#6b7280;margin:0 0 16px">The renewal permission you granted is now <strong>dormant</strong> — we won't use it. You don't need to do anything. If you'd like full on-chain control, you can revoke it anytime in your wallet's permissions settings.</p>
    <p style="color:#9ca3af;font-size:12px;margin:24px 0 0">Sent once. Your funds are safe.</p>
  </div>
</body>
</html>`;
}

export function passwordResetEmailHtml(name: string, url: string): string {
  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f9fafb;padding:40px 0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb">
    <h1 style="font-size:24px;font-weight:700;color:#111827;margin:0 0 8px">Reset your password</h1>
    <p style="color:#6b7280;margin:0 0 24px">Hi ${name}, we received a request to reset your Sweep Console password. Click the button below to choose a new one.</p>
    <a href="${url}" style="display:inline-block;background:#16a34a;color:#fff;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none">Reset password</a>
    <p style="color:#9ca3af;font-size:12px;margin:24px 0 0">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't change.</p>
  </div>
</body>
</html>`;
}

export function verificationEmailHtml(name: string, url: string): string {
  return `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f9fafb;padding:40px 0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb">
    <h1 style="font-size:24px;font-weight:700;color:#111827;margin:0 0 8px">Verify your email</h1>
    <p style="color:#6b7280;margin:0 0 24px">Hi ${name}, click the button below to verify your email and set up your Sweep Console account.</p>
    <a href="${url}" style="display:inline-block;background:#1128F5;color:#fff;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none">Verify email &amp; set password</a>
    <p style="color:#9ca3af;font-size:12px;margin:24px 0 0">This link expires in 24 hours. If you didn't request this, ignore this email.</p>
  </div>
</body>
</html>`;
}
