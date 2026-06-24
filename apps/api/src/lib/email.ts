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

// Delivery is a failover chain: Resend (primary) → Brevo (fallback) → SMTP.
// Both Resend and Brevo are HTTP APIs (port 443), so they work on hosts that
// block outbound SMTP (e.g. Railway). On the free tiers Resend allows 100
// emails/day and Brevo 300/day; when Resend errors — including exhausting its
// daily quota — we fall through to Brevo for that send. A detected daily-quota
// error also parks Resend until the next UTC reset so we stop wasting calls on it.

function fromAddress(): string {
  return (
    process.env.EMAIL_FROM ??
    process.env.SMTP_FROM ??
    "Sweep Console <noreply@sweepconsole.com>"
  );
}

// Resend takes the raw "Name <email>" string; Brevo wants it split out.
function parseFrom(raw: string): { email: string; name?: string } {
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || undefined, email: m[2].trim() };
  return { email: raw.trim() };
}

class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly quotaExhausted = false) {
    super(message);
  }
}

// ─── Resend (primary) ─────────────────────────────────────────────────────────
async function sendViaResend(opts: SendOptions): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
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
  if (res.ok) return;

  const body = (await res.json().catch(() => ({}))) as { name?: string; message?: string };
  const detail = `${body.name ?? ""} ${body.message ?? res.statusText}`.trim();
  // Resend signals the 100/day cap with a 429 mentioning the daily quota.
  const quotaExhausted = res.status === 429 && /daily|quota/i.test(detail);
  throw new ProviderError(`Resend ${res.status}: ${detail}`, res.status, quotaExhausted);
}

// ─── Brevo (fallback) ─────────────────────────────────────────────────────────
async function sendViaBrevo(opts: SendOptions): Promise<void> {
  const from = parseFrom(fromAddress());
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY as string,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: from.name ? { email: from.email, name: from.name } : { email: from.email },
      to: [{ email: opts.to }],
      subject: opts.subject,
      htmlContent: opts.html,
      textContent: opts.text,
    }),
  });
  if (res.ok) return;
  const detail = await res.text().catch(() => "");
  throw new ProviderError(`Brevo ${res.status}: ${detail.slice(0, 200)}`, res.status);
}

// ─── SMTP (last resort, e.g. local dev) ───────────────────────────────────────
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
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// Epoch ms until which Resend is skipped after a daily-quota 429 (resets at UTC midnight).
let resendDisabledUntil = 0;
function nextUtcMidnight(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

type Provider = { name: string; send: (o: SendOptions) => Promise<void> };

function providers(): Provider[] {
  const list: Provider[] = [];
  if (process.env.RESEND_API_KEY) list.push({ name: "Resend", send: sendViaResend });
  if (process.env.BREVO_API_KEY) list.push({ name: "Brevo", send: sendViaBrevo });
  const transport = getTransport();
  if (transport) {
    list.push({ name: "SMTP", send: (o) => transport.sendMail({ from: fromAddress(), ...o }).then(() => {}) });
  }
  return list;
}

export async function sendEmail(opts: SendOptions): Promise<void> {
  const list = providers();

  // Nothing configured — log so local dev still surfaces the content.
  if (list.length === 0) {
    console.log("\n─────────────────────────────────────────");
    console.log("[email] No email provider configured (RESEND_API_KEY / BREVO_API_KEY / SMTP_HOST) — logging instead");
    console.log("[email] To:", opts.to);
    console.log("[email] Subject:", opts.subject);
    console.log("[email] Body:", opts.text);
    console.log("─────────────────────────────────────────\n");
    return;
  }

  const errors: string[] = [];
  for (const p of list) {
    // Skip Resend while its daily free-tier quota is known-exhausted.
    if (p.name === "Resend" && Date.now() < resendDisabledUntil) continue;
    try {
      await p.send(opts);
      console.log(`[email] Sent to ${opts.to} via ${p.name}`);
      return;
    } catch (e) {
      const err = e as ProviderError;
      if (p.name === "Resend" && err.quotaExhausted) {
        resendDisabledUntil = nextUtcMidnight();
        console.warn("[email] Resend daily quota exhausted — routing to fallback until UTC reset");
      } else {
        console.error(`[email] ${p.name} failed:`, err.message);
      }
      errors.push(`${p.name}: ${err.message}`);
    }
  }

  throw new Error(`Failed to send email — all providers failed: ${errors.join(" | ")}`);
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
    <p style="color:#9ca3af;font-size:12px;margin:8px 0 0">Manage your subscriptions anytime at <a href="${manageUrl()}" style="color:#16a34a">${manageUrl()}</a>.</p>
  </div>
</body>
</html>`;
}

/// The standalone customer portal URL (email + OTP) where a subscriber manages
/// every subscription tied to their email across merchants.
function manageUrl(): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/manage`;
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
    <p style="color:#6b7280;margin:0 0 16px">You can review and manage your other subscriptions anytime at <a href="${manageUrl()}" style="color:#16a34a">${manageUrl()}</a>.</p>
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
