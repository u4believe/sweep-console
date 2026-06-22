import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ok, err } from "../lib/response";
import { ids } from "../lib/ids";
import {
  getManagerAddress,
  getUsdcAddress,
  settlementWindowSeconds,
} from "../lib/chain/subscription";
import { subscribeWithPermitOnChain } from "../lib/chain/contract";
import { buildPermitPayload } from "../lib/checkout/cctp-activate";
import {
  completeCheckoutSession,
  CheckoutVerificationError,
  INTERVAL_SECONDS,
} from "../lib/checkout/complete";
import { createCheckoutSession, SessionCreationError } from "../lib/checkout/session";
import { resolveTier } from "../lib/checkout/tiers";
import {
  lookupCustomerByEmail,
  lookupCustomerByWallet,
  requestEmailOtp,
  verifyEmailOtp,
  resolveProvenCustomer,
  OtpError,
} from "../lib/checkout/identity";
import { revokeSubscription } from "../lib/subscriptions/revoke";
import type { Hex } from "viem";

// The subscriber grants a year of renewals in one EIP-2612 permit, mirroring
// the standard path's USDC.approve(amount × 12).
const ALLOWANCE_PERIODS = 12n;

function splitSignature(signature: string): { v: number; r: Hex; s: Hex } {
  const sig = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (sig.length !== 130) throw new Error("Expected a 65-byte signature");
  const r = `0x${sig.slice(0, 64)}` as Hex;
  const s = `0x${sig.slice(64, 128)}` as Hex;
  let v = parseInt(sig.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { v, r, s };
}

export const publicRouter = Router();

// ─── Customer identity: lookup + OTP (public) ─────────────────────────────────
// Email is the identity anchor. On wallet connect the checkout asks whether this
// wallet already belongs to a known customer (returns only a MASKED email, so a
// wallet→email lookup can't deanonymize anyone). A new wallet/email proves
// ownership once via a 6-digit OTP; returning wallets skip it.

// Email-anchored recall: the email is the identity. Given the email entered at
// checkout, recognise a returning customer of THIS merchant and recall the wallet
// they last paid with (masked). Per-merchant via the checkout session.
publicRouter.get("/customer/recall", async (req, res) => {
  const email = String(req.query.email ?? "");
  const sessionId = String(req.query.session_id ?? "");
  if (!email.includes("@")) {
    return err(res, "Invalid or missing ?email parameter", 400);
  }
  try {
    const session = sessionId
      ? await prisma.checkoutSession.findUnique({
          where: { sessionId },
          select: { merchantId: true },
        })
      : null;
    if (!session) {
      return ok(res, { known: false, verified: false, wallet_masked: null });
    }
    const result = await lookupCustomerByEmail(session.merchantId, email);
    return ok(res, { known: result.known, verified: result.verified, wallet_masked: result.walletMasked });
  } catch (e) {
    console.error("[public/customer/recall]", e);
    return err(res, "Recall failed", 500);
  }
});

// Wallet-based recognition: is THIS connected wallet already an OTP-verified
// customer of this merchant? If so the checkout skips the OTP step (it's already
// linked). Scoped to the session's merchant.
publicRouter.get("/customer/wallet-status", async (req, res) => {
  const address = String(req.query.address ?? "");
  const sessionId = String(req.query.session_id ?? "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return err(res, "Invalid or missing ?address parameter", 400);
  }
  try {
    const session = sessionId
      ? await prisma.checkoutSession.findUnique({ where: { sessionId }, select: { merchantId: true } })
      : null;
    if (!session) return ok(res, { linked: false, verified: false, email_masked: null });
    const result = await lookupCustomerByWallet(session.merchantId, address);
    return ok(res, { linked: result.linked, verified: result.verified, email_masked: result.emailMasked });
  } catch (e) {
    console.error("[public/customer/wallet-status]", e);
    return err(res, "Lookup failed", 500);
  }
});

const otpRequestSchema = z.object({
  email: z.string().email(),
  session_id: z.string().optional(), // to label the email with the merchant
});

publicRouter.post("/customer/otp/request", async (req, res) => {
  const parsed = otpRequestSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "A valid email is required", 422);
  try {
    let merchantName = "your subscription";
    if (parsed.data.session_id) {
      const session = await prisma.checkoutSession.findUnique({
        where: { sessionId: parsed.data.session_id },
        include: { merchant: { select: { name: true } } },
      });
      if (session) merchantName = session.merchant.name;
    }
    await requestEmailOtp(parsed.data.email, merchantName);
    return ok(res, { sent: true });
  } catch (e) {
    console.error("[public/customer/otp/request]", e);
    return err(res, "Could not send the code. Try again shortly.", 502);
  }
});

const otpVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
});

publicRouter.post("/customer/otp/verify", async (req, res) => {
  const parsed = otpVerifySchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Enter the 6-digit code", 422);
  try {
    const token = await verifyEmailOtp(parsed.data.email, parsed.data.code);
    return ok(res, { verified: true, email_token: token });
  } catch (e) {
    if (e instanceof OtpError) return err(res, e.message, e.httpStatus);
    console.error("[public/customer/otp/verify]", e);
    return err(res, "Verification failed", 500);
  }
});

// ─── Gated reveal: manage existing subscriptions ──────────────────────────────
// After the email is recognised (masked) at checkout, the page can reveal the
// FULL email + linked wallets + active subscriptions so the customer can revoke
// before upgrading. Revealing is gated on PROOF OF CONTROL — a verified-email
// token (OTP) or a connected wallet already linked to this customer — so a typed
// email can never be used to enumerate someone's wallet.

const provenLookupSchema = z.object({
  session_id: z.string(),
  email: z.string().email(),
  email_token: z.string(), // OTP proof — required; a typed email alone reveals nothing
});

publicRouter.post("/customer/subscriptions", async (req, res) => {
  const parsed = provenLookupSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);
  const { session_id, email, email_token } = parsed.data;
  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: session_id },
      select: { merchantId: true },
    });
    if (!session) return err(res, "Checkout session not found", 404);

    const proven = await resolveProvenCustomer({
      merchantId: session.merchantId,
      email,
      emailToken: email_token,
    });
    // Same shape whether the customer doesn't exist or control isn't proven, so a
    // typed email can't distinguish "registered here" from "unverified".
    if (!proven) return ok(res, { proven: false, email: null, wallets: [], subscriptions: [] });

    const subs = await prisma.subscription.findMany({
      where: {
        merchantId: session.merchantId,
        status: { in: ["active", "trialing", "past_due"] },
        OR: [{ customerId: proven.customerDbId }, { subscriberEmail: proven.email }],
      },
      include: { plan: true, renewalDelegations: { where: { status: "active" } } },
      orderBy: { createdAt: "desc" },
    });

    return ok(res, {
      proven: true,
      email: proven.email,
      wallets: proven.wallets.map((w) => ({ address: w.address, last_used_at: w.lastUsedAt.toISOString() })),
      subscriptions: subs.map((s) => ({
        id: s.subscriptionId,
        status: s.status,
        wallet_address: s.walletAddress,
        plan: { name: s.plan.name, amount: Number(s.amount), interval: s.interval, currency: s.plan.currency },
        current_period_end: s.currentPeriodEnd.toISOString(),
        permissions: {
          arc_subscription: !!s.onChainSubId,
          cross_chain_grants: s.renewalDelegations.length,
        },
        // Any active sub can be revoked (cancel on-chain + revoke delegations).
        revocable: !!s.onChainSubId || s.renewalDelegations.length > 0,
      })),
    });
  } catch (e) {
    console.error("[public/customer/subscriptions]", e);
    return err(res, "Failed to load subscriptions", 500);
  }
});

// Self-serve revoke before upgrading — same proof as the reveal above. On-chain
// cancel gas is platform-paid; the DB revoke is the guarantee, so a transient
// chain failure still neutralises the permission (on_chain_cancelled = false).
publicRouter.post("/customer/subscriptions/:id/revoke", async (req, res) => {
  const parsed = provenLookupSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);
  const { session_id, email, email_token } = parsed.data;
  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: session_id },
      select: { merchantId: true, merchant: { select: { merchantId: true } } },
    });
    if (!session) return err(res, "Checkout session not found", 404);

    const proven = await resolveProvenCustomer({
      merchantId: session.merchantId,
      email,
      emailToken: email_token,
    });
    if (!proven) return err(res, "Verify your email to manage this subscription.", 403);

    const sub = await prisma.subscription.findFirst({
      where: {
        subscriptionId: req.params.id as string,
        merchantId: session.merchantId,
        OR: [{ customerId: proven.customerDbId }, { subscriberEmail: proven.email }],
      },
      include: { plan: true },
    });
    if (!sub) return err(res, "Subscription not found", 404, "not_found");
    if (sub.status === "cancelled") return err(res, "This subscription is already cancelled", 409);

    const result = await revokeSubscription(sub, session.merchant.merchantId, {
      reason: "revoked_by_customer",
    });

    return ok(res, {
      id: sub.subscriptionId,
      status: "cancelled",
      revoked_delegations: result.revokedDelegations,
      refunded_escrow: Number(result.refundedEscrow),
      on_chain_cancelled: !result.onChainError,
      tx_hash: result.cancelTxHash,
    });
  } catch (e) {
    console.error("[public/customer/subscriptions/revoke]", e);
    return err(res, "Failed to revoke subscription", 500);
  }
});

// ─── Payment Links (public) ───────────────────────────────────────────────────
// A reusable, shareable URL. GET returns the plan summary for the landing page;
// POST mints a fresh checkout session on demand (Stripe Payment Link model).

publicRouter.get("/pay/:link_id", async (req, res) => {
  try {
    const link = await prisma.paymentLink.findUnique({
      where: { linkId: req.params.link_id as string },
      include: { plan: true, merchant: { select: { name: true } } },
    });
    if (!link || !link.active || link.plan.archived) {
      return err(res, "This payment link is no longer active", 404);
    }
    return ok(res, {
      link_id: link.linkId,
      merchant: { name: link.merchant.name },
      test_mode: link.isTestMode,
      plan: {
        name: link.plan.name,
        description: link.plan.description ?? "",
        amount: Number(link.plan.amount),
        currency: link.plan.currency,
        interval: link.plan.interval,
        trialDays: link.plan.trialDays,
      },
    });
  } catch (e) {
    console.error("[public/pay GET]", e);
    return err(res, "Failed to load payment link", 500);
  }
});

const paySessionSchema = z.object({
  // The sharer can append ?ref=<their user id>; otherwise we generate one so
  // every subscription still has a stable external_ref for webhooks.
  external_ref: z.string().min(1).max(255).optional(),
});

publicRouter.post("/pay/:link_id/session", async (req, res) => {
  const parsed = paySessionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return err(res, "Invalid payload", 422);

  try {
    const link = await prisma.paymentLink.findUnique({
      where: { linkId: req.params.link_id as string },
      include: { plan: true },
    });
    if (!link || !link.active || link.plan.archived) {
      return err(res, "This payment link is no longer active", 404);
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const externalRef = parsed.data.external_ref ?? `${link.linkId}_${ids.sessionToken().slice(0, 12)}`;

    const { session, checkoutUrl } = await createCheckoutSession({
      merchantId: link.merchantId,
      plan: link.plan,
      externalRef,
      successUrl: link.successUrl ?? `${appUrl}/checkout/{SESSION_ID}`,
      cancelUrl: link.cancelUrl ?? appUrl,
      metadata: { payment_link_id: link.linkId },
      isTestMode: link.isTestMode,
    });

    return ok(res, { session_id: session.sessionId, checkout_url: checkoutUrl });
  } catch (e) {
    if (e instanceof SessionCreationError) return err(res, e.message, e.httpStatus, e.code);
    console.error("[public/pay session]", e);
    return err(res, "Failed to start checkout", 500);
  }
});

// ─── GET /checkout/:session_id ────────────────────────────────────────────────
// Public — called by the checkout page to load session data.

publicRouter.get("/checkout/:session_id", async (req, res) => {
  const { session_id } = req.params as { session_id: string };

  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: session_id },
      include: {
        plan: { include: { tiers: { where: { archived: false }, orderBy: { amount: "asc" } } } },
        merchant: {
          select: { name: true, merchantId: true, walletAddress: true, walletType: true, addressVerifiedAt: true },
        },
      },
    });

    if (!session) return err(res, "Checkout session not found", 404);

    if (session.status === "complete") {
      return ok(res, { status: "complete" });
    }

    if (session.status === "expired" || new Date() > session.expiresAt) {
      return ok(res, { status: "expired" });
    }

    // subscribe() pushes settled funds straight to this address — never expose
    // checkout for a missing or unverified (external path B) payout wallet.
    const { walletAddress, walletType, addressVerifiedAt } = session.merchant;
    if (!walletAddress || (walletType === "external" && !addressVerifiedAt)) {
      return err(res, "This merchant cannot accept payments yet.", 409);
    }

    const planMeta = session.plan.metadata as unknown as
      | { defaultTierName?: string; defaultFeatures?: string[] }
      | null;

    return ok(res, {
      status: "open",
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      plan: {
        name: session.plan.name,
        description: session.plan.description ?? "",
        amount: Number(session.plan.amount),
        currency: session.plan.currency,
        interval: session.plan.interval,
        trialDays: session.plan.trialDays,
        // Default-tier display name + features (fall back to the plan name client-side).
        defaultTierName: planMeta?.defaultTierName ?? null,
        defaultFeatures: planMeta?.defaultFeatures ?? null,
      },
      // Tiers the subscriber can choose (the plan above is the default tier). The
      // page computes the on-chain amount/interval/trial for the chosen tier and
      // sets it via PATCH /checkout/:id/tier before subscribing.
      tiers: session.plan.tiers.map((t) => ({
        id: t.id,
        name: t.name,
        amount: Number(t.amount),
        interval: t.interval,
        trialDays: t.trialDays,
        features: t.features ?? null,
      })),
      merchant: { name: session.merchant.name },
      isTestMode: session.isTestMode,
      cancelUrl: session.cancelUrl,
      // Everything the checkout page needs for the two on-chain transactions:
      // USDC.approve(manager, amount × 12) then manager.subscribe(...)
      onchain: {
        subId: ids.toBytes32(session.sessionId),
        managerAddress: getManagerAddress(),
        usdcAddress: getUsdcAddress(),
        merchantPayout: walletAddress,
        planIdBytes32: ids.toBytes32(session.plan.planId),
        amount: session.plan.amount.toString(),
        intervalSeconds: INTERVAL_SECONDS[session.plan.interval] ?? INTERVAL_SECONDS.monthly,
        trialSeconds: session.plan.trialDays * 86_400,
        settlementWindowSeconds: settlementWindowSeconds(session.plan.settlementWindowHours),
      },
    });
  } catch (e) {
    console.error("[public/checkout]", e);
    return err(res, "Failed to load checkout session", 500);
  }
});

// ─── POST /checkout/:session_id/tier ──────────────────────────────────────────
// The subscriber's chosen tier (null = the plan's default tier). Set BEFORE
// activating; every charge path reads session.tierId via resolveTier().
const selectTierSchema = z.object({
  session_token: z.string().min(1),
  tier_id: z.string().nullable().optional(),
});

publicRouter.post("/checkout/:session_id/tier", async (req, res) => {
  const parsed = selectTierSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);
  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: req.params.session_id as string },
      select: { id: true, sessionToken: true, status: true, planId: true },
    });
    if (!session) return err(res, "Checkout session not found", 404);
    if (session.sessionToken !== parsed.data.session_token) return err(res, "Invalid session token", 401);
    if (session.status !== "open") return err(res, "Session is not open", 409);

    const tierId = parsed.data.tier_id ?? null;
    if (tierId) {
      const tier = await prisma.planTier.findFirst({
        where: { id: tierId, planId: session.planId, archived: false },
        select: { id: true },
      });
      if (!tier) return err(res, "Tier not found for this plan", 404);
    }
    await prisma.checkoutSession.update({ where: { id: session.id }, data: { tierId } });
    return ok(res, { tier_id: tierId });
  } catch (e) {
    console.error("[public/checkout/tier]", e);
    return err(res, "Failed to select tier", 500);
  }
});

// ─── POST /internal/checkout/confirm ─────────────────────────────────────────
// Called by the checkout UI after the subscriber's on-chain tx is confirmed.

const confirmSchema = z.object({
  session_id: z.string(),
  // subscribe() tx — absent when a retry found the subscription already on-chain
  tx_hash: z.string().optional(),
  allowance_tx_hash: z.string().optional(), // USDC.approve() transaction
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  email: z.string().email().optional(),
  email_token: z.string().optional(), // OTP proof, required to link a new wallet
  block_number: z.number().optional(),
});

publicRouter.post("/internal/checkout/confirm", async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);

  const { session_id, tx_hash, allowance_tx_hash, wallet_address, email, email_token, block_number } = parsed.data;

  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: session_id },
      include: { plan: true, merchant: true },
    });

    if (!session || session.status !== "open") {
      return err(res, "Session not found or already complete", 404);
    }

    const { subscription, redirectUrl } = await completeCheckoutSession({
      session,
      walletAddress: wallet_address,
      activationMethod: "wallet",
      email,
      emailToken: email_token,
      txHash: tx_hash,
      allowanceTxHash: allowance_tx_hash,
      blockNumber: block_number,
    });

    return ok(res, { subscription_id: subscription.subscriptionId, redirect_url: redirectUrl });
  } catch (e) {
    if (e instanceof CheckoutVerificationError) {
      return err(res, e.message, e.httpStatus);
    }
    console.error("[internal/checkout/confirm]", e);
    return err(res, "Failed to confirm checkout", 500);
  }
});

// ─── Gasless same-chain checkout ──────────────────────────────────────────────
// The subscriber signs ONE EIP-2612 permit off-chain; the platform submits
// subscribeWithPermit() on Arc and pays the gas. Step 1 returns the typed data
// to sign; step 2 submits it.

const permitRequestSchema = z.object({
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

publicRouter.post("/internal/checkout/:session_id/permit", async (req, res) => {
  const parsed = permitRequestSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);

  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: req.params.session_id as string },
      include: { plan: true },
    });
    if (!session || session.status !== "open" || new Date() > session.expiresAt) {
      return err(res, "Checkout session is not open", 409);
    }

    const tier = await resolveTier(session.plan, session.tierId);
    const permitValue = tier.amount * ALLOWANCE_PERIODS;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const payload = await buildPermitPayload(parsed.data.wallet_address as Hex, permitValue, deadline);

    return ok(res, {
      permit_payload: payload,
      permit_value: permitValue.toString(),
      permit_deadline: deadline.toString(),
    });
  } catch (e) {
    console.error("[internal/checkout/permit]", e);
    return err(res, "Failed to build permit", 502);
  }
});

const gaslessSchema = z.object({
  session_id: z.string(),
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  email: z.string().email().optional(),
  email_token: z.string().optional(),
  permit_signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
  permit_value: z.string().regex(/^\d+$/),
  permit_deadline: z.string().regex(/^\d+$/),
});

publicRouter.post("/internal/checkout/gasless", async (req, res) => {
  const parsed = gaslessSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);

  const { session_id, wallet_address, email, email_token, permit_signature, permit_value, permit_deadline } = parsed.data;

  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: session_id },
      include: { plan: true, merchant: true },
    });
    if (!session || session.status !== "open") {
      return err(res, "Session not found or already complete", 404);
    }
    if (!session.merchant.walletAddress) {
      return err(res, "Merchant has no payout wallet", 409);
    }

    const plan = session.plan;
    const tier = await resolveTier(plan, session.tierId);
    const { v, r, s } = splitSignature(permit_signature);

    // Platform arbiter submits + pays Arc gas — gasless for the subscriber
    await subscribeWithPermitOnChain({
      subId: ids.toBytes32(session.sessionId),
      subscriber: wallet_address as Hex,
      merchantPayout: session.merchant.walletAddress as Hex,
      planId: ids.toBytes32(plan.planId),
      amount: tier.amount,
      interval: BigInt(INTERVAL_SECONDS[tier.interval] ?? INTERVAL_SECONDS.monthly),
      trialDuration: BigInt(tier.trialDays * 86_400),
      settlementWindow: BigInt(settlementWindowSeconds(tier.settlementWindowHours)),
      permitValue: BigInt(permit_value),
      permitDeadline: BigInt(permit_deadline),
      permitV: v,
      permitR: r,
      permitS: s,
    });

    const { subscription, redirectUrl } = await completeCheckoutSession({
      session,
      walletAddress: wallet_address,
      activationMethod: "wallet",
      email,
      emailToken: email_token,
    });

    return ok(res, { subscription_id: subscription.subscriptionId, redirect_url: redirectUrl });
  } catch (e) {
    if (e instanceof CheckoutVerificationError) return err(res, e.message, e.httpStatus);
    console.error("[internal/checkout/gasless]", e);
    return err(res, "Gasless activation failed — you can retry or pay directly.", 502);
  }
});
