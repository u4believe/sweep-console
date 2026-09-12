import nodemailer from "nodemailer";
import {
  shell, lede, heroAmount, codeBlock, detailRows, panel, alarm, button,
  fineprint, fallbackUrl, emailLink, mono, esc, manageUrl,
} from "./email-shell";
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

/* ── Templates ───────────────────────────────────────────────────────────────
 * Each is a call to shell() with body rows. Signatures are unchanged from
 * before the redesign, so no call site moved.
 */

/// Subscriber's checkout confirmation code. NOTICE sender: they are confirming
/// a purchase from a merchant, and seeing that merchant's name is how they know
/// which of their tabs asked for it.
export function otpEmailHtml(code: string, merchantName: string): string {
  return shell({
    preheader: `Your ${merchantName} confirmation code is ${code}. It expires in 10 minutes.`,
    sender: "notice",
    merchantName,
    kicker: "Confirm",
    title: "Your confirmation code",
    body:
      lede(`Enter this code to confirm your email and complete your subscription with <strong style="color:#201e1d;">${esc(merchantName)}</strong>. It works once.`) +
      codeBlock(code) +
      detailRows([
        { k: "Merchant", v: esc(merchantName) },
        { k: "Expires", v: "10 minutes from when it was sent" },
      ]) +
      fineprint(
        `If you didn't ask for this code you can ignore this email — nothing happens without it. ` +
        `Manage every subscription on this address at ${emailLink(manageUrl().replace(/^https?:\/\//, ""), manageUrl())}.`
      ),
  });
}

/// Merchant's step-up code, for confirming a destructive action in the portal.
/// ACCOUNT sender, and it names the action so a code nobody asked for reads as
/// the alarm it is.
export function stepUpEmailHtml(
  code: string,
  merchantName: string,
  actionLabel: string,
  expiresInSeconds: number
): string {
  const window = expiresInSeconds < 120 ? `${expiresInSeconds} seconds` : `${Math.round(expiresInSeconds / 60)} minutes`;
  return shell({
    preheader: `Your Sweep Console confirmation code is ${code}. It expires in ${window}.`,
    sender: "account",
    kicker: "Security",
    title: "Confirm it's you",
    body:
      lede(`Hi ${esc(merchantName)}, enter this code in Sweep Console to ${esc(actionLabel)}.`) +
      codeBlock(code) +
      detailRows([
        { k: "Action", v: esc(actionLabel) },
        { k: "Expires", v: esc(window) },
        { k: "Uses", v: "Once" },
      ]) +
      alarm(
        "Didn't do this?",
        `Someone else may be signed in to your account. Change your password now, and turn on an authenticator app under Settings → Security — it's the only proof accepted for payouts and API keys.`
      ),
  });
}

/// Sent ONCE when a creator closes a plan. Trust-first: billing has already
/// stopped, so this is a receipt, not a request. It carries no refund line — the
/// platform holds nothing to return, and saying "Refund: not applicable" on every
/// closure only raises a question the subscriber wasn't asking.
export function planClosedEmailHtml(opts: {
  merchantName: string;
  planName: string;
  subscriptionId: string;
}): string {
  return shell({
    preheader: `${opts.planName} is closed. You won't be charged again — nothing to cancel.`,
    sender: "notice",
    merchantName: opts.merchantName,
    kicker: "Subscription ended",
    title: `${opts.planName} has been closed`,
    body:
      lede(
        `${esc(opts.merchantName)} closed this plan, so it will not renew. You don't need to cancel ` +
        `anything or revoke anything — the authorization stops being used the moment a plan closes.`
      ) +
      detailRows([
        { k: "Plan", v: esc(opts.planName) },
        { k: "Subscription", v: mono(opts.subscriptionId) },
        { k: "Further charges", v: "None", accent: true },
      ]) +
      fineprint(
        `The renewal permission you granted is now dormant — we won't use it. If you'd like full ` +
        `on-chain control you can revoke it anytime from your wallet.`
      ) +
      button("Manage your subscriptions", manageUrl()),
  });
}

/// Merchant password reset. One button, one fallback URL.
export function passwordResetEmailHtml(name: string, url: string, expiresInMinutes: number): string {
  return shell({
    preheader: `Reset your Sweep Console password. The link expires in ${expiresInMinutes} minutes.`,
    sender: "account",
    kicker: "Security",
    title: "Reset your password",
    body:
      lede(`Hi ${esc(name)}, we received a request to reset your Sweep Console password. Choose a new one below.`) +
      button("Reset password", url) +
      fallbackUrl("If the button doesn't work", url) +
      detailRows([
        { k: "Link expires", v: `${expiresInMinutes} minutes from when it was sent` },
        { k: "Uses", v: "Once" },
      ]) +
      fineprint(
        `If you didn't request this you can safely ignore this email — your password won't change. ` +
        `Sweep Console never asks for your password, recovery phrase or private key by email.`
      ),
  });
}

/// Signup address verification.
export function verificationEmailHtml(name: string, url: string): string {
  return shell({
    preheader: "One tap to verify your address and finish setting up Sweep Console.",
    sender: "account",
    kicker: "Verify",
    title: "Confirm this is your address",
    body:
      lede(
        `Hi ${esc(name)}, verifying unlocks payout settlement and lets us reach you about failed ` +
        `renewals. The link is good for 24 hours.`
      ) +
      button("Verify email & set password", url) +
      fallbackUrl("If the button doesn't work", url) +
      fineprint(
        `Didn't create a Sweep Console account? Ignore this email and the request expires on its own.`
      ),
  });
}

/// Payout-address change notification. Not a request — a receipt that doubles
/// as an alarm, because this is the setting that decides where money lands.
export function payoutWalletEmailHtml(name: string, address: string): string {
  return shell({
    preheader: `Your Sweep Console payout wallet was set to ${address.slice(0, 10)}…`,
    sender: "account",
    kicker: "Security",
    title: "Payout wallet updated",
    body:
      lede(`Hi ${esc(name)}, your payout wallet was verified and every future settlement will land there.`) +
      detailRows([
        { k: "New payout address", v: mono(address) },
        { k: "Settlement chain", v: "Arc" },
        { k: "Changed", v: new Date().toUTCString() },
      ]) +
      alarm(
        "Didn't do this?",
        `Change your password immediately and turn on an authenticator app under Settings → Security. ` +
        `Your existing balance is not at risk — Sweep Console can never move your funds — but an ` +
        `intruder could redirect future settlements.`
      ),
  });
}

export interface ReceiptEmailData {
  merchantName: string;
  planName: string;
  /// Tier label, when the subscriber chose one that isn't the plan default.
  tierName?: string | null;
  /// Human-readable, e.g. "29.00".
  amount: string;
  currency: string;
  interval: string;
  chargedAt: Date;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  /// Where the money came FROM — "Base", "Arc", etc.
  paidFromChain: string;
  walletAddress?: string | null;
  txHash?: string | null;
  explorerUrl?: string | null;
  nextRenewalAt?: Date | null;
  /**
   * Supported source chains this subscriber has NOT yet authorized for renewal.
   *
   * Decides whether the renewal panel invites them to grant the rest or simply
   * tells them it is handled. Undefined means "unknown", which takes the invite
   * copy: asking is never wrong, whereas promising automatic renewal to someone
   * who granted nothing is.
   */
  ungrantedChains?: number | null;
  /// True for the first charge of a subscription rather than a renewal.
  isFirstCharge: boolean;
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…`;
}

function shortAddress(a: string): string {
  return a.length >= 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/// The payment receipt. The amount leads, on-chain proof sits in the ledger, and
/// the next charge is stated before the subscriber thinks to ask.
export function receiptEmailHtml(d: ReceiptEmailData): string {
  const planLabel = d.tierName ? `${d.planName} · ${d.tierName}` : d.planName;
  const period =
    d.periodStart && d.periodEnd ? `${DATE.format(d.periodStart)} – ${DATE.format(d.periodEnd)}` : null;
  const paidFrom = d.walletAddress
    ? `${esc(d.currency)} on ${esc(d.paidFromChain)} · ${esc(shortAddress(d.walletAddress))}`
    : `${esc(d.currency)} on ${esc(d.paidFromChain)}`;

  return shell({
    preheader:
      `Paid ${d.amount} ${d.currency} to ${d.merchantName} — ${planLabel}.` +
      (d.nextRenewalAt ? ` Next renewal ${DATE.format(d.nextRenewalAt)}.` : ""),
    sender: "notice",
    merchantName: d.merchantName,
    kicker: "Payment successful",
    title: d.isFirstCharge ? "Your subscription is active" : "Renewal paid",
    body:
      heroAmount(
        d.amount,
        d.currency,
        `Charged ${esc(DATE.format(d.chargedAt))} for <strong style="color:#201e1d;">${esc(d.planName)}</strong>` +
          (d.tierName ? ` — ${esc(d.tierName)} tier` : "") +
          `, billed ${esc(d.interval)}.`
      ) +
      detailRows([
        { k: "Plan", v: esc(planLabel) },
        ...(period ? [{ k: "Billing period", v: esc(period) }] : []),
        { k: "Paid from", v: paidFrom },
        { k: "Settled on", v: "Arc" },
        // Gas is the first thing a crypto-native subscriber looks for.
        { k: "Network fee", v: "Covered", accent: true },
        ...(d.txHash
          ? [{
              k: "Transaction",
              v: d.explorerUrl
                ? emailLink(`${shortHash(d.txHash)} · View on explorer`, d.explorerUrl)
                : mono(d.txHash),
            }]
          : []),
      ]) +
      (d.nextRenewalAt
        ? panel(
            "Next renewal",
            `${DATE.format(d.nextRenewalAt)} — ${d.amount} ${d.currency}`,
            d.ungrantedChains === 0
              ? `Charged automatically from your wallet on any supported chain holding ` +
                  `enough USDC. Nothing for you to do — we submit it and pay the gas.`
              : `Want to be charged automatically from your wallet on any of the supported ` +
                  `chains holding enough USDC? Head to the ` +
                  `<strong style="color:#201e1d;">Manage your subscriptions</strong> page by ` +
                  `clicking the button below to grant permission to the remaining supported chains.`
          )
        : "") +
      button("Manage your subscriptions", manageUrl()) +
      fineprint(
        `Cancel anytime by revoking the authorization from your wallet. ` +
        `Every subscription tied to this email address — across all merchants — is at ` +
        `${emailLink(manageUrl().replace(/^https?:\/\//, ""), manageUrl())}.`
      ),
  });
}
