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

/// "daily" is what the API takes and what the mandate stores; "day" is what a
/// sentence needs. Same mapping the authorization page shows the payer, so the
/// receipt reads back in the words they agreed in.
const INTERVAL_NOUN: Record<string, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

export interface RailChargeReceiptData {
  merchantName: string;
  /// The developer's own line for what this charge was — the ONLY thing that
  /// tells the payer what they bought. Sweep has no plan to name here.
  description?: string | null;
  /// Human-readable, e.g. "2.00".
  amount: string;
  currency: string;
  chargedAt: Date;
  /// Where the money came FROM — "Base", "Optimism".
  paidFromChain: string;
  walletAddress?: string | null;
  txHash?: string | null;
  explorerUrl?: string | null;
  /// The standing authorization this was collected under, restated so the payer
  /// can check the charge against what they agreed to.
  ceiling: string;
  interval: string;
  authorizationExpiresAt: Date;
}

/**
 * The receipt for one charge on the external rail.
 *
 * Deliberately NOT receiptEmailHtml with fields blanked out. That email is built
 * around a subscription Sweep runs: a plan name, a billing period, the next
 * renewal date, and a button to /manage. A mandate has none of those — the
 * developer owns the schedule, so we genuinely do not know when the next charge
 * lands, and /manage lists subscriptions this payer does not have. Every one of
 * those fields would have to be a guess or a lie.
 *
 * What this one can say honestly: what was taken, by whom, from where, the proof
 * on chain, the ceiling it was taken under, and the one control the payer
 * actually holds — revoking the permission in their own wallet.
 */
export function railChargeReceiptEmailHtml(d: RailChargeReceiptData): string {
  // "per daily" is not English. The interval is stored as an adjective because
  // that is the word the API takes; every sentence here needs the noun, the same
  // way the authorization page does it.
  const noun = INTERVAL_NOUN[d.interval] ?? d.interval;
  const paidFrom = d.walletAddress
    ? `${esc(d.currency)} on ${esc(d.paidFromChain)} · ${esc(shortAddress(d.walletAddress))}`
    : `${esc(d.currency)} on ${esc(d.paidFromChain)}`;

  return shell({
    preheader: `${d.merchantName} charged ${d.amount} ${d.currency} from your wallet.`,
    sender: "notice",
    merchantName: d.merchantName,
    kicker: "Payment taken",
    title: `${d.merchantName} charged ${d.amount} ${d.currency}`,
    // /manage is keyed on subscriptions, which a mandate payer has none of.
    footerContact:
      `Questions about this charge? Contact ${esc(d.merchantName)} directly — they set the amount and ` +
      `decide when to charge. Sweep Console moved the funds and never held them.`,
    body:
      heroAmount(
        d.amount,
        d.currency,
        `Charged ${esc(DATE.format(d.chargedAt))} by <strong style="color:#201e1d;">${esc(d.merchantName)}</strong>` +
          (d.description ? ` for ${esc(d.description)}` : "") +
          `, under the permission you authorized from your wallet.`
      ) +
      detailRows([
        ...(d.description ? [{ k: "For", v: esc(d.description) }] : []),
        { k: "Paid from", v: paidFrom },
        { k: "Settled on", v: "Arc" },
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
      // The ceiling, not a next-charge date. Stating a date we do not know would
      // be the one line in this email most likely to be wrong.
      panel(
        "Your authorization",
        `Up to ${d.ceiling} ${d.currency} per ${esc(noun)}`,
        `${esc(d.merchantName)} can charge up to this much in total per ${esc(noun)} — in one charge or ` +
          `several — until ${esc(DATE.format(d.authorizationExpiresAt))}. They set their own schedule, so there ` +
          `is no fixed next-charge date.`
      ) +
      fineprint(
        `Didn't expect this? The permission lives in your wallet, not with us: revoke it there and no ` +
        `further charge can be collected. Past charges settle directly to ${esc(d.merchantName)} and are not ` +
        `reversible by Sweep Console — ask them for a refund.`
      ),
  });
}

export interface RailAccessRequestData {
  merchantName: string;
  merchantEmail: string;
  merchantPublicId: string;
  /// Whether they can actually be paid yet. A rail charge dies on
  /// no_payout_wallet without one, so this decides whether granting the rail is
  /// enough or whether they need a nudge first.
  payoutWallet: string | null;
  planCount: number;
  subscriptionCount: number;
  requestedAt: Date;
}

/**
 * Sent to the operator when a creator asks for the external rail.
 *
 * An account-facing "notice" would be wrong: nobody is being notified about
 * their own subscription, this is internal mail about someone else's account.
 * It carries the few facts the decision actually turns on — can they be paid,
 * have they used the platform at all — so granting does not begin with looking
 * all of that up.
 */
export function railAccessRequestEmailHtml(d: RailAccessRequestData): string {
  return shell({
    preheader: `${d.merchantName} requested the external payment rail.`,
    sender: "account",
    kicker: "Access request",
    title: "A creator asked for the payment rail",
    body:
      lede(
        `<strong style="color:#201e1d;">${esc(d.merchantName)}</strong> requested access to the external ` +
        `payment rail. Nothing has been granted — the switch is still ` +
        `<code>scripts/external-rail.ts</code>.`
      ) +
      detailRows([
        { k: "Account", v: esc(d.merchantName) },
        { k: "Email", v: esc(d.merchantEmail) },
        { k: "Merchant ID", v: mono(d.merchantPublicId) },
        {
          k: "Payout wallet",
          v: d.payoutWallet ? mono(d.payoutWallet) : "NOT LINKED — charges would fail",
          accent: !d.payoutWallet,
        },
        { k: "Plans", v: String(d.planCount) },
        { k: "Subscriptions", v: String(d.subscriptionCount) },
        { k: "Requested", v: esc(d.requestedAt.toISOString()) },
      ]) +
      fineprint(
        `To grant it: <code>pnpm tsx scripts/external-rail.ts ${esc(d.merchantEmail)} --on --write</code>. ` +
        `It dry-runs without <code>--write</code>.`
      ),
  });
}

export interface PriceChangeEmailData {
  merchantName: string;
  planName: string;
  oldAmount: string;
  newAmount: string;
  currency: string;
  interval: string;
  /// When the new price first applies — the end of the period they have paid for.
  effectiveFrom: Date | null;
  /**
   * True when this subscriber's signed wallet permission cannot cover the new
   * price. They are not at risk of being overcharged — their wallet would refuse
   * it — but nothing will be collected until they authorize the new amount, so
   * this is the difference between "for your information" and "action needed".
   */
  needsReauthorization: boolean;
}

/**
 * Sent to every affected subscriber when a creator changes a price.
 *
 * A price change is the one thing a standing authorization must never do
 * quietly. The subscriber signed a cap, not a subscription to whatever the
 * creator later decides, so this states both numbers and who changed it — and
 * when their permission cannot cover the new price, it leads with that rather
 * than burying it, because otherwise they discover it as a payment that silently
 * stopped.
 */
export function priceChangeEmailHtml(d: PriceChangeEmailData): string {
  const up = Number(d.newAmount) > Number(d.oldAmount);
  const noun = INTERVAL_NOUN[d.interval] ?? d.interval;

  return shell({
    preheader:
      `${d.merchantName} changed ${d.planName} from ${d.oldAmount} to ${d.newAmount} ${d.currency} per ${noun}.` +
      (d.needsReauthorization ? " Your authorization needs updating." : ""),
    sender: "notice",
    merchantName: d.merchantName,
    kicker: d.needsReauthorization ? "Action needed" : "Price change",
    title: up ? `${d.planName} now costs more` : `${d.planName} now costs less`,
    footerContact:
      `Questions about the new price? Contact ${esc(d.merchantName)} directly — they set it. ` +
      `Sweep Console collects what they list and can never take more than your wallet has authorized.`,
    body:
      heroAmount(
        d.newAmount,
        d.currency,
        `per ${esc(noun)}, from ${esc(d.oldAmount)} ${esc(d.currency)}. Changed by ` +
          `<strong style="color:#201e1d;">${esc(d.merchantName)}</strong>` +
          (d.effectiveFrom ? `, applying from ${esc(DATE.format(d.effectiveFrom))}.` : ".")
      ) +
      detailRows([
        { k: "Plan", v: esc(d.planName) },
        { k: "Was", v: `${esc(d.oldAmount)} ${esc(d.currency)} per ${esc(noun)}` },
        { k: "Now", v: `${esc(d.newAmount)} ${esc(d.currency)} per ${esc(noun)}`, accent: true },
        ...(d.effectiveFrom
          ? [{ k: "First charged", v: esc(DATE.format(d.effectiveFrom)) }]
          : []),
      ]) +
      (d.needsReauthorization
        ? alarm(
            "Your authorization is too small",
            `You authorized up to ${esc(d.oldAmount)} ${esc(d.currency)} per ${esc(noun)}, so the new price ` +
              `cannot be collected — your wallet would refuse it, and we will not try. Nothing has been ` +
              `charged and nothing will be until you approve the new amount. Update it from the page below, ` +
              `or cancel if you would rather not continue.`
          )
        : panel(
            "Nothing to do",
            "Your existing authorization covers this",
            `The permission you already signed allows up to ${esc(d.oldAmount)} ${esc(d.currency)} per ` +
              `${esc(noun)}, so the new price is collected the same way as before.`
          )) +
      button(d.needsReauthorization ? "Update your authorization" : "Manage your subscriptions", manageUrl()) +
      fineprint(
        `You can cancel at any time, and revoke the permission in your wallet whenever you like — ` +
        `only you can remove it. Periods already paid for are not affected.`
      ),
  });
}

/**
 * Sent to a creator when an operator grants them the external rail.
 *
 * The request screen promises "we'll email you when it is live", and a promise
 * made by a product is the product's to keep. Without this the creator's only
 * way to discover the grant is to open the portal and notice the screen has
 * changed — which is not a notification, it is luck.
 */
export function railAccessGrantedEmailHtml(opts: { merchantName: string; hasPayoutWallet: boolean }): string {
  return shell({
    preheader: "The payment rail is now enabled on your Sweep Console account.",
    sender: "account",
    kicker: "Access granted",
    title: "The payment rail is live on your account",
    body:
      lede(
        `Hi ${esc(opts.merchantName)}, your account can now create mandates and collect charges. ` +
        `<code>/v1/mandates</code> and <code>/v1/charges</code> will stop answering ` +
        `<code>403 rail_not_enabled</code>.`
      ) +
      detailRows([
        { k: "What changed", v: "Payment rail enabled", accent: true },
        {
          k: "Payout wallet",
          v: opts.hasPayoutWallet
            ? "Linked"
            : "NOT LINKED — link one before your first charge",
          accent: !opts.hasPayoutWallet,
        },
        { k: "Mode", v: "Test — live API keys are not issued yet" },
      ]) +
      (opts.hasPayoutWallet
        ? ""
        : alarm(
            "Link a payout wallet first",
            "A mandate will be created and authorized without one, and then the first charge fails — " +
              "after the payer has already signed. Settings → Payout wallet."
          )) +
      panel(
        "Where to start",
        "Create your first mandate",
        "The Payment rail screen in the portal now lists your mandates and charges. The docs carry a " +
          "working integration: the route that creates a mandate and redirects, the webhook handler, and " +
          "the charge loop."
      ) +
      button("Open the payment rail", `${process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? ""}/rail`) +
      fineprint(
        "Your API key is a payment credential on this rail — it can move money to whoever holds it. " +
        "Treat it like one, and rotate it from API Keys if it has ever been pasted somewhere it should not be."
      ),
  });
}
