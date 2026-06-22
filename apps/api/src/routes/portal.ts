import { Router } from "express";
import { z } from "zod";
import { createHmac, randomBytes } from "crypto";
import { addMinutes } from "date-fns";
import { verifyMessage } from "viem";
import type { Prisma } from "@prisma/client";
import { prisma, withRetry } from "../lib/prisma";
import { ids } from "../lib/ids";
import { ok, created, err, validationError } from "../lib/response";
import { verifyPassword } from "../lib/password";
import { sendEmail } from "../lib/email";
import { verifyPortalSession } from "../middleware/portalAuth";
import type { PortalRequest } from "../middleware/portalAuth";
import { closePlanSubscriptions, findSubsToClose } from "../lib/plan-lifecycle";

function hmacKey(rawKey: string): string {
  const secret = process.env.PLATFORM_API_SIGNING_SECRET;
  if (!secret) throw new Error("PLATFORM_API_SIGNING_SECRET is not set");
  return createHmac("sha256", secret).update(rawKey).digest("hex");
}
import {
  createCircleUser,
  getCircleUserToken,
  createCircleWalletChallenge,
  createCircleWalletForExistingUser,
  getCircleWallets,
  getCircleChallengeStatus,
  getCircleWalletById,
  getCircleWalletBalances,
  createCircleTransferChallenge,
  registerWebhookSubscription,
} from "../lib/circle";

export const portalRouter = Router();

portalRouter.use(verifyPortalSession);

// ─── GET /portal/dashboard ────────────────────────────────────────────────────

portalRouter.get("/dashboard", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    // Sequential queries (not Promise.all) so only one connection is used at a time.
    // This avoids P1001/P2024 errors when the connection pool is cold or constrained.
    const activeSubs = await withRetry(() => prisma.subscription.count({
      where: { merchantId: dbId, status: { in: ["active", "trialing"] } },
    }));
    const revenue = await withRetry(() => prisma.payment.aggregate({
      where: { merchantId: dbId, status: "succeeded", type: { in: ["initial", "renewal"] } },
      _sum: { amount: true },
    }));
    const plans = await withRetry(() => prisma.plan.count({ where: { merchantId: dbId, archived: false } }));
    const failedPayments = await withRetry(() => prisma.payment.count({ where: { merchantId: dbId, status: "failed" } }));
    const merchant = await withRetry(() => prisma.merchant.findUniqueOrThrow({
      where: { id: dbId },
      select: { walletAddress: true, walletType: true, addressVerifiedAt: true },
    }));

    return ok(res, {
      data: {
        activeSubs,
        totalRevenue: Number(revenue._sum.amount ?? 0n),
        plans,
        failedPayments,
        walletAddress: merchant.walletAddress,
        walletType: merchant.walletType,
        addressVerifiedAt: merchant.addressVerifiedAt?.toISOString() ?? null,
      },
    });
  } catch (e) {
    console.error("[portal/dashboard]", e);
    return err(res, "Failed to load dashboard", 500);
  }
});

// ─── GET /portal/me ───────────────────────────────────────────────────────────

portalRouter.get("/me", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: dbId },
      select: {
        merchantId: true,
        name: true,
        email: true,
        webhookSecret: true,
        walletAddress: true,
        walletType: true,
        addressVerifiedAt: true,
        pendingWalletAddress: true,
        isLive: true,
      },
    });
    return ok(res, { data: merchant });
  } catch (e) {
    console.error("[portal/me]", e);
    return err(res, "Failed to load profile", 500);
  }
});

// ─── GET/POST /portal/plans ───────────────────────────────────────────────────

portalRouter.get("/plans", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const plans = await prisma.plan.findMany({
      where: { merchantId: dbId, archived: false },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { subscriptions: true } },
        tiers: { where: { archived: false }, orderBy: { amount: "asc" } },
      },
    });
    return ok(res, {
      data: plans.map((p) => ({
        id: p.planId,
        name: p.name,
        description: p.description,
        amount: Number(p.amount),
        currency: p.currency,
        interval: p.interval,
        trial_days: p.trialDays,
        subscribers: p._count.subscriptions,
        default_tier_name:
          (p.metadata as unknown as { defaultTierName?: string } | null)?.defaultTierName ?? null,
        tiers: p.tiers.map((t) => ({
          id: t.id,
          name: t.name,
          amount: Number(t.amount),
          interval: t.interval,
          trial_days: t.trialDays,
          features: t.features ?? null,
        })),
      })),
    });
  } catch (e) {
    console.error("[portal/plans GET]", e);
    return err(res, "Failed to load plans", 500);
  }
});

const createPlanSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  amount: z.number().int().positive(),
  currency: z.enum(["USDC", "EURC"]).default("USDC"),
  interval: z.enum(["daily", "weekly", "monthly", "yearly"]),
  trial_days: z.number().int().min(0).max(365).default(0),
  // Per-plan escrow window for first payments (the only refund path);
  // omit to use the platform default SETTLEMENT_WINDOW_HOURS
  settlement_window_hours: z.number().int().min(1).max(720).optional(),
  metadata: z.record(z.unknown()).optional(),
});

portalRouter.post("/plans", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;

  const parsed = createPlanSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }

  try {
    // One active plan per merchant — delete the existing one before creating a new one.
    const activePlan = await prisma.plan.findFirst({
      where: { merchantId: dbId, archived: false },
      select: { id: true },
    });
    if (activePlan) {
      return err(res, "You already have an active plan. Delete it before creating a new one.", 409, "plan_exists");
    }

    const { name, description, amount, currency, interval, trial_days, settlement_window_hours, metadata } = parsed.data;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20);

    const plan = await prisma.plan.create({
      data: {
        planId: ids.plan(slug),
        merchantId: dbId,
        name,
        description,
        amount: BigInt(amount),
        currency,
        interval,
        trialDays: trial_days,
        settlementWindowHours: settlement_window_hours ?? null,
        metadata: (metadata ?? {}) as Prisma.InputJsonValue,
      },
    });

    return created(res, {
      id: plan.planId,
      name: plan.name,
      amount: Number(plan.amount),
      currency: plan.currency,
      interval: plan.interval,
      trial_days: plan.trialDays,
    });
  } catch (e) {
    console.error("[portal/plans POST]", e);
    return err(res, "Failed to create plan", 500);
  }
});

// Delete (close) a plan: soft-delete + self-enforced cancel/refund/notify of every
// subscriber. Responds immediately with how many subs are being closed.
portalRouter.delete("/plans/:id", async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;
  try {
    const plan = await prisma.plan.findFirst({
      where: { planId: req.params.id as string, merchantId: dbId },
    });
    if (!plan) return err(res, "Plan not found", 404);
    if (plan.archived) return ok(res, { archived: true, cancelling: 0 });

    await prisma.plan.update({ where: { id: plan.id }, data: { archived: true } });

    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: dbId },
      select: { name: true, merchantId: true },
    });
    const subs = await findSubsToClose(plan.id);
    void closePlanSubscriptions(
      { name: plan.name, currency: plan.currency, merchantName: merchant.name, merchantPublicId: merchant.merchantId },
      subs
    ).catch((e) => console.error("[portal/plans DELETE] closing subscriptions failed:", e));

    return ok(res, { archived: true, cancelling: subs.length });
  } catch (e) {
    console.error("[portal/plans DELETE]", e);
    return err(res, "Failed to delete plan", 500);
  }
});

// ─── Plan tiers (append-only) ─────────────────────────────────────────────────
const createTierSchema = z.object({
  name: z.string().min(1).max(60),
  amount: z.number().int().positive(),
  interval: z.enum(["daily", "weekly", "monthly", "yearly"]),
  trial_days: z.number().int().min(0).max(365).default(0),
  features: z.array(z.string()).optional(),
});

portalRouter.post("/plans/:id/tiers", async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;
  const parsed = createTierSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }
  try {
    const plan = await prisma.plan.findFirst({
      where: { planId: req.params.id as string, merchantId: dbId, archived: false },
    });
    if (!plan) return err(res, "Plan not found", 404);
    const d = parsed.data;
    const tier = await prisma.planTier.create({
      data: {
        planId: plan.id,
        name: d.name,
        amount: BigInt(d.amount),
        interval: d.interval,
        trialDays: d.trial_days,
        features: (d.features ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    return created(res, {
      id: tier.id,
      name: tier.name,
      amount: Number(tier.amount),
      interval: tier.interval,
      trial_days: tier.trialDays,
      features: tier.features ?? null,
    });
  } catch (e) {
    console.error("[portal/plans tiers POST]", e);
    return err(res, "Failed to add tier", 500);
  }
});

// Archive a tier (append-only model: tiers aren't edited, only retired). Existing
// subscriptions snapshot their terms, so archiving never changes a live sub.
portalRouter.delete("/plans/:id/tiers/:tierId", async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;
  try {
    const plan = await prisma.plan.findFirst({
      where: { planId: req.params.id as string, merchantId: dbId },
      select: { id: true },
    });
    if (!plan) return err(res, "Plan not found", 404);
    await prisma.planTier.updateMany({
      where: { id: req.params.tierId as string, planId: plan.id },
      data: { archived: true },
    });
    return ok(res, { archived: true });
  } catch (e) {
    console.error("[portal/plans tiers DELETE]", e);
    return err(res, "Failed to archive tier", 500);
  }
});

// ─── Payment Links ────────────────────────────────────────────────────────────
// Reusable, shareable checkout URLs (Stripe Payment Link model). Each visit
// mints a fresh checkout session; the link itself carries no subscriber.

function paymentLinkUrl(linkId: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${appUrl}/pay/${linkId}`;
}

portalRouter.get("/payment-links", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const links = await prisma.paymentLink.findMany({
      where: { merchantId: dbId, active: true },
      include: { plan: { select: { name: true, planId: true, amount: true, currency: true, interval: true } } },
      orderBy: { createdAt: "desc" },
    });
    return ok(res, {
      data: links.map((l) => ({
        id: l.linkId,
        url: paymentLinkUrl(l.linkId),
        plan_id: l.plan.planId,
        plan_name: l.plan.name,
        amount: Number(l.plan.amount),
        currency: l.plan.currency,
        interval: l.plan.interval,
        test_mode: l.isTestMode,
        created_at: l.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    console.error("[portal/payment-links GET]", e);
    return err(res, "Failed to load payment links", 500);
  }
});

const createPaymentLinkSchema = z.object({
  plan_id: z.string(),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});

portalRouter.post("/payment-links", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const parsed = createPaymentLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }
  const { plan_id, success_url, cancel_url } = parsed.data;

  try {
    const plan = await prisma.plan.findFirst({
      where: { planId: plan_id, merchantId: dbId, archived: false },
    });
    if (!plan) return err(res, "Plan not found", 404, "not_found");

    // One active link per plan — reuse it so the shareable URL stays stable
    const existing = await prisma.paymentLink.findFirst({
      where: { merchantId: dbId, planId: plan.id, active: true },
    });
    if (existing) {
      return ok(res, { id: existing.linkId, url: paymentLinkUrl(existing.linkId), reused: true });
    }

    const link = await prisma.paymentLink.create({
      data: {
        linkId: ids.paymentLink(),
        merchantId: dbId,
        planId: plan.id,
        successUrl: success_url ?? null,
        cancelUrl: cancel_url ?? null,
        isTestMode: true, // test keys only in beta
      },
    });

    return created(res, { id: link.linkId, url: paymentLinkUrl(link.linkId) });
  } catch (e) {
    console.error("[portal/payment-links POST]", e);
    return err(res, "Failed to create payment link", 500);
  }
});

portalRouter.delete("/payment-links/:id", async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;
  try {
    const count = await prisma.paymentLink.updateMany({
      where: { linkId: req.params.id as string, merchantId: dbId, active: true },
      data: { active: false },
    });
    if (count.count === 0) return err(res, "Payment link not found", 404);
    return ok(res, { success: true });
  } catch (e) {
    console.error("[portal/payment-links DELETE]", e);
    return err(res, "Failed to deactivate payment link", 500);
  }
});

// ─── GET /portal/subscriptions ────────────────────────────────────────────────

portalRouter.get("/subscriptions", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const subs = await prisma.subscription.findMany({
      where: { merchantId: dbId },
      include: { plan: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return ok(res, {
      data: subs.map((s) => ({
        id: s.subscriptionId,
        externalRef: s.externalRef,
        email: s.subscriberEmail ?? null,
        planName: s.plan.name,
        status: s.status,
        currentPeriodEnd: s.currentPeriodEnd.toISOString(),
        walletAddress: s.walletAddress,
        isTestMode: s.isTestMode,
      })),
    });
  } catch (e) {
    console.error("[portal/subscriptions]", e);
    return err(res, "Failed to load subscriptions", 500);
  }
});

// ─── GET /portal/payments ─────────────────────────────────────────────────────

portalRouter.get("/payments", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const payments = await prisma.payment.findMany({
      where: { merchantId: dbId },
      include: { subscription: { include: { plan: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return ok(res, {
      data: payments.map((p) => ({
        id: p.paymentId,
        amount: Number(p.amount),
        currency: p.currency,
        status: p.status,
        type: p.type,
        planName: p.subscription?.plan.name ?? null,
        txHash: p.txHash,
        createdAt: p.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    console.error("[portal/payments]", e);
    return err(res, "Failed to load payments", 500);
  }
});

// ─── GET /portal/webhooks ─────────────────────────────────────────────────────

portalRouter.get("/webhooks", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { merchantId: dbId, isActive: true },
      include: {
        _count: { select: { deliveries: true } },
        deliveries: { orderBy: { createdAt: "desc" }, take: 5 },
      },
      orderBy: { createdAt: "desc" },
    });
    return ok(res, {
      data: endpoints.map((ep) => ({
        id: ep.endpointId,
        url: ep.url,
        events: ep.events,
        deliveryCount: ep._count.deliveries,
        recentDeliveries: ep.deliveries.map((d) => ({
          id: d.eventId,
          eventType: d.eventType,
          status: d.status,
          createdAt: d.createdAt.toISOString(),
        })),
      })),
    });
  } catch (e) {
    console.error("[portal/webhooks]", e);
    return err(res, "Failed to load webhooks", 500);
  }
});

// ─── Wallet routes ────────────────────────────────────────────────────────────
//
// External payout addresses (merchant path B) MUST be ownership-verified before
// any funds can be pushed to them: the server issues a nonce, the developer
// signs it with the wallet (personal_sign), and the server checks the signature
// before setting addressVerifiedAt. Changing an already-linked address
// additionally requires the account password (step-up auth).

const NONCE_TTL_MINUTES = 10;

function walletVerificationMessage(address: string, nonce: string): string {
  return (
    `SweepConsole payout wallet verification\n\n` +
    `Wallet: ${address}\n` +
    `Nonce: ${nonce}\n\n` +
    `Signing this message proves you control this wallet. ` +
    `It does not authorize any transaction or cost any gas.`
  );
}

// Step 1 — register the address and receive the message to sign.
portalRouter.post("/wallet/external", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const address = (req.body.walletAddress as string | undefined)?.trim();
  const password = req.body.password as string | undefined;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return err(res, "Invalid wallet address. Must be a 0x-prefixed 20-byte hex string.", 400);
  }

  try {
    const merchant = await withRetry(() =>
      prisma.merchant.findUniqueOrThrow({
        where: { id: dbId },
        select: { walletAddress: true, passwordHash: true },
      })
    );

    // Changing an existing payout address requires step-up auth
    if (merchant.walletAddress) {
      if (!password || !(await verifyPassword(password, merchant.passwordHash))) {
        return err(res, "Enter your account password to change the payout address.", 401);
      }
    }

    const nonce = randomBytes(16).toString("hex");
    const expiresAt = addMinutes(new Date(), NONCE_TTL_MINUTES);

    await prisma.merchant.update({
      where: { id: dbId },
      data: {
        pendingWalletAddress: address.toLowerCase(),
        walletNonce: nonce,
        walletNonceExpiresAt: expiresAt,
      },
    });

    return ok(res, {
      message: walletVerificationMessage(address.toLowerCase(), nonce),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e) {
    console.error("[portal/wallet/external]", e);
    return err(res, "Failed to start wallet verification", 500);
  }
});

// Step 2 — verify the personal_sign signature and activate the payout address.
portalRouter.post("/wallet/external/verify", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const signature = (req.body.signature as string | undefined)?.trim();

  if (!signature || !/^0x[a-fA-F0-9]+$/.test(signature)) {
    return err(res, "Missing or malformed signature", 400);
  }

  try {
    const merchant = await withRetry(() =>
      prisma.merchant.findUniqueOrThrow({
        where: { id: dbId },
        select: {
          email: true,
          name: true,
          pendingWalletAddress: true,
          walletNonce: true,
          walletNonceExpiresAt: true,
        },
      })
    );

    if (!merchant.pendingWalletAddress || !merchant.walletNonce) {
      return err(res, "No wallet verification in progress. Submit the address first.", 409);
    }
    if (!merchant.walletNonceExpiresAt || merchant.walletNonceExpiresAt < new Date()) {
      return err(res, "Verification nonce expired. Submit the address again.", 410);
    }

    const valid = await verifyMessage({
      address: merchant.pendingWalletAddress as `0x${string}`,
      message: walletVerificationMessage(merchant.pendingWalletAddress, merchant.walletNonce),
      signature: signature as `0x${string}`,
    });

    if (!valid) {
      return err(res, "Signature was not produced by the pending wallet address.", 401);
    }

    const verifiedAt = new Date();
    await prisma.merchant.update({
      where: { id: dbId },
      data: {
        walletAddress: merchant.pendingWalletAddress,
        walletType: "external",
        circleWalletId: null,
        addressVerifiedAt: verifiedAt,
        pendingWalletAddress: null,
        walletNonce: null,
        walletNonceExpiresAt: null,
      },
    });

    // Best-effort security notification — a payout-address change moves money
    sendEmail({
      to: merchant.email,
      subject: "SweepConsole payout wallet updated",
      html: `<p>Hi ${merchant.name},</p><p>Your payout wallet was verified and set to <code>${merchant.pendingWalletAddress}</code>. If you did not make this change, reset your password immediately.</p>`,
      text: `Your SweepConsole payout wallet was verified and set to ${merchant.pendingWalletAddress}. If you did not make this change, reset your password immediately.`,
    }).catch((e) => console.warn("[portal/wallet/external/verify] notification email failed:", e));

    return ok(res, {
      walletAddress: merchant.pendingWalletAddress,
      addressVerifiedAt: verifiedAt.toISOString(),
    });
  } catch (e) {
    console.error("[portal/wallet/external/verify]", e);
    return err(res, "Failed to verify wallet", 500);
  }
});

portalRouter.post("/wallet/unlink", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    await prisma.merchant.update({
      where: { id: dbId },
      data: {
        walletAddress: null,
        addressVerifiedAt: null,
        pendingWalletAddress: null,
        walletNonce: null,
        walletNonceExpiresAt: null,
      },
    });
    return ok(res, { success: true });
  } catch (e) {
    console.error("[portal/wallet/unlink]", e);
    return err(res, "Failed to unlink wallet", 500);
  }
});

portalRouter.post("/wallet/circle", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;

  try {
    const merchant = await withRetry(() =>
      prisma.merchant.findUniqueOrThrow({
        where: { id: dbId },
        select: { walletType: true },
      })
    );

    if (merchant.walletType === "circle") {
      return err(res, "A Circle wallet was already created for this account.", 409);
    }

    try { await createCircleUser(dbId); } catch { /* may already exist */ }

    const { userToken, encryptionKey } = await getCircleUserToken(dbId);

    // If the user was already initialized in a previous attempt, they may already have
    // a wallet — return it directly without needing a new challenge.
    try {
      const existingWallets = await getCircleWallets(userToken);
      const existing = existingWallets.find((w) => w.state === "LIVE") ?? existingWallets[0];
      if (existing) {
        await withRetry(() =>
          prisma.merchant.update({
            where: { id: dbId },
            // Circle user-controlled wallets (path A) are ownership-implicit
            data: { walletAddress: existing.address.toLowerCase(), walletType: "circle", circleWalletId: existing.id, addressVerifiedAt: new Date() },
          })
        );
        return ok(res, { walletAddress: existing.address.toLowerCase(), alreadySetup: true });
      }
    } catch { /* no wallets yet — fall through to initialize */ }

    let challengeId: string;
    try {
      ({ challengeId } = await createCircleWalletChallenge(userToken));
    } catch (e) {
      // 409 means already initialized but no wallet returned above — create via wallet endpoint
      if (e instanceof Error && e.message.includes("409")) {
        ({ challengeId } = await createCircleWalletForExistingUser(userToken));
      } else {
        throw e;
      }
    }

    return ok(res, {
      userToken,
      encryptionKey,
      challengeId,
      appId: process.env.NEXT_PUBLIC_CIRCLE_APP_ID,
    });
  } catch (e) {
    console.error("[portal/wallet/circle]", e);
    const message = e instanceof Error ? e.message : "Failed to start wallet creation";
    return err(res, message, 502);
  }
});

portalRouter.post("/wallet/circle/confirm", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const { challengeId } = req.body as { challengeId?: string };
  try {
    const { userToken } = await getCircleUserToken(dbId);

    let wallet: import("../lib/circle").CircleWallet | undefined;

    // Primary path: get the wallet ID directly from the challenge's correlationIds.
    // GET /v1/w3s/user/wallets returns 404 for some Circle accounts even when a wallet
    // was successfully created, so we bypass it when the challengeId is available.
    if (challengeId) {
      try {
        const cs = await getCircleChallengeStatus(userToken, challengeId);
        const { status, correlationIds } = cs.challenge;
        console.log(`[portal/wallet/confirm] challenge ${challengeId}: ${status}, correlationIds:`, correlationIds);

        if (status === "COMPLETE" && correlationIds?.length) {
          for (const walletId of correlationIds) {
            const w = await getCircleWalletById(walletId);
            console.log(`[portal/wallet/confirm] wallet ${walletId}:`, w);
            if (w?.address) { wallet = w; break; }
          }
        }
      } catch (e) {
        console.warn("[portal/wallet/confirm] challenge status fetch failed:", (e as Error).message);
      }
    }

    // Fallback: poll user wallet list (works for some Circle configurations)
    if (!wallet) {
      for (let i = 0; i < 6; i++) {
        try {
          const wallets = await getCircleWallets(userToken);
          wallet = wallets.find((w) => w.state === "LIVE") ?? wallets[0];
          if (wallet) break;
        } catch (e) {
          const is404 = e instanceof Error && e.message.includes("404");
          if (!is404) throw e;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (!wallet) {
      return err(res, "Wallet not found — the Circle challenge may not have completed. Please try again.", 404);
    }

    await prisma.merchant.update({
      where: { id: dbId },
      // Circle user-controlled wallets (path A) are ownership-implicit
      data: { walletAddress: wallet.address.toLowerCase(), walletType: "circle", circleWalletId: wallet.id, addressVerifiedAt: new Date() },
    });

    return ok(res, { walletAddress: wallet.address.toLowerCase() });
  } catch (e) {
    console.error("[portal/wallet/circle/confirm]", e);
    const message = e instanceof Error ? e.message : "Failed to save wallet";
    return err(res, message, 502);
  }
});

portalRouter.post("/wallet/relink-circle", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: dbId },
      select: { walletType: true },
    });

    if (merchant.walletType !== "circle") {
      return err(res, "No Circle wallet is associated with this account.", 400);
    }

    const { userToken } = await getCircleUserToken(dbId);
    const wallets = await getCircleWallets(userToken);
    const wallet = wallets.find((w) => w.state === "LIVE") ?? wallets[0];

    if (!wallet) return err(res, "Could not find your Circle wallet.", 404);

    await prisma.merchant.update({
      where: { id: dbId },
      data: { walletAddress: wallet.address.toLowerCase() },
    });

    return ok(res, { walletAddress: wallet.address.toLowerCase() });
  } catch (e) {
    console.error("[portal/wallet/relink-circle]", e);
    const message = e instanceof Error ? e.message : "Failed to re-link wallet";
    return err(res, message, 502);
  }
});

// ─── GET /portal/api-keys ─────────────────────────────────────────────────────

portalRouter.get("/api-keys", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: dbId },
      select: { testKeyHash: true, testKeyName: true, testKeyPrefix: true },
    });
    return ok(res, {
      data: {
        hasTestKey: !!merchant.testKeyHash,
        name: merchant.testKeyName,
        prefix: merchant.testKeyPrefix ?? null,
      },
    });
  } catch (e) {
    console.error("[portal/api-keys GET]", e);
    return err(res, "Failed to load API keys", 500);
  }
});

const apiKeyRegenerateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
});

// ─── GET /portal/wallet/circle/balance ────────────────────────────────────────

const BALANCE_STALE_MS = 5 * 60 * 1000; // 5 minutes

portalRouter.get("/wallet/circle/balance", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const forceRefresh = req.query.refresh === "1";
  try {
    const merchant = await withRetry(() =>
      prisma.merchant.findUniqueOrThrow({
        where: { id: dbId },
        select: { walletType: true, circleWalletId: true, usdcBalance: true, balanceUpdatedAt: true },
      })
    );
    if (merchant.walletType !== "circle" || !merchant.circleWalletId) {
      return err(res, "No Circle wallet found", 404);
    }

    const cacheAge = merchant.balanceUpdatedAt ? Date.now() - merchant.balanceUpdatedAt.getTime() : Infinity;
    const isFresh = !forceRefresh && cacheAge < BALANCE_STALE_MS;

    if (isFresh) {
      return ok(res, {
        data: {
          usdcBalance: merchant.usdcBalance,
          tokenId: null,
          walletId: merchant.circleWalletId,
          updatedAt: merchant.balanceUpdatedAt?.toISOString() ?? null,
          fromCache: true,
        },
      });
    }

    // Fetch live from Circle and update cache
    const balances = await getCircleWalletBalances(merchant.circleWalletId);
    const usdc = balances.find((b) => b.token.symbol === "USDC");
    const liveBalance = usdc?.amount ?? "0";

    await withRetry(() =>
      prisma.merchant.update({
        where: { id: dbId },
        data: { usdcBalance: liveBalance, balanceUpdatedAt: new Date() },
      })
    );

    return ok(res, {
      data: {
        usdcBalance: liveBalance,
        tokenId: usdc?.token.id ?? null,
        walletId: merchant.circleWalletId,
        updatedAt: new Date().toISOString(),
        fromCache: false,
      },
    });
  } catch (e) {
    console.error("[portal/wallet/circle/balance]", e);
    return err(res, "Failed to fetch balance", 500);
  }
});

// ─── POST /portal/circle/subscribe-webhook ────────────────────────────────────
// One-time call to register this platform's webhook URL with Circle.
// Circle will send transactions.inbound events to the given URL.

const subscribeWebhookSchema = z.object({
  url: z.string().url("Must be a valid HTTPS URL"),
});

portalRouter.post("/circle/subscribe-webhook", async (req, res) => {
  const parsed = subscribeWebhookSchema.safeParse(
    req.body.url ? req.body : { url: process.env.CIRCLE_WEBHOOK_URL }
  );
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }
  try {
    const result = await registerWebhookSubscription(parsed.data.url);
    console.log("[portal/circle/subscribe-webhook] Registered:", result);
    return ok(res, { subscriptionId: result.id, endpoint: result.endpoint });
  } catch (e) {
    console.error("[portal/circle/subscribe-webhook]", e);
    const message = e instanceof Error ? e.message : "Failed to register webhook";
    return err(res, message, 502);
  }
});

// ─── POST /portal/wallet/circle/withdraw ──────────────────────────────────────

const withdrawSchema = z.object({
  destinationAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address"),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "Invalid amount").refine((v) => parseFloat(v) > 0, "Amount must be positive"),
});

portalRouter.post("/wallet/circle/withdraw", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const parsed = withdrawSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }
  const { destinationAddress, amount } = parsed.data;
  try {
    const merchant = await withRetry(() =>
      prisma.merchant.findUniqueOrThrow({
        where: { id: dbId },
        select: { walletType: true, circleWalletId: true },
      })
    );
    if (merchant.walletType !== "circle" || !merchant.circleWalletId) {
      return err(res, "No Circle wallet found", 404);
    }
    const balances = await getCircleWalletBalances(merchant.circleWalletId);
    const usdc = balances.find((b) => b.token.symbol === "USDC");
    if (!usdc) return err(res, "No USDC balance found in your wallet", 404);
    if (parseFloat(usdc.amount) < parseFloat(amount)) {
      return err(res, `Insufficient balance. Available: ${usdc.amount} USDC`, 400);
    }
    const { userToken, encryptionKey } = await getCircleUserToken(dbId);
    const { challengeId } = await createCircleTransferChallenge(
      userToken,
      merchant.circleWalletId,
      usdc.token.id,
      destinationAddress,
      amount
    );
    return ok(res, { userToken, encryptionKey, challengeId, appId: process.env.NEXT_PUBLIC_CIRCLE_APP_ID });
  } catch (e) {
    console.error("[portal/wallet/circle/withdraw]", e);
    const message = e instanceof Error ? e.message : "Failed to initiate withdrawal";
    return err(res, message, 502);
  }
});

// ─── POST /portal/webhooks ────────────────────────────────────────────────────

const ALLOWED_EVENTS = [
  "subscription.created",
  "subscription.renewed",
  "subscription.cancelled",
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
] as const;

const createWebhookSchema = z.object({
  url: z.string().url("Must be a valid URL").max(500),
  events: z.array(z.enum(ALLOWED_EVENTS)).min(1, "Select at least one event"),
});

portalRouter.post("/webhooks", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  const parsed = createWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }
  const { url, events } = parsed.data;
  const { randomBytes } = await import("crypto");
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  try {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        endpointId: ids.webhook(),
        merchantId: dbId,
        url,
        events,
        secret,
        isActive: true,
      },
    });
    return created(res, {
      id: endpoint.endpointId,
      url: endpoint.url,
      events: endpoint.events,
      secret: endpoint.secret,
    });
  } catch (e) {
    console.error("[portal/webhooks POST]", e);
    return err(res, "Failed to create webhook endpoint", 500);
  }
});

// ─── DELETE /portal/webhooks/:id ─────────────────────────────────────────────

portalRouter.delete("/webhooks/:id", async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;
  const endpointId = req.params.id;
  try {
    const count = await prisma.webhookEndpoint.updateMany({
      where: { endpointId, merchantId: dbId, isActive: true },
      data: { isActive: false },
    });
    if (count.count === 0) return err(res, "Endpoint not found", 404);
    return ok(res, { success: true });
  } catch (e) {
    console.error("[portal/webhooks DELETE]", e);
    return err(res, "Failed to delete webhook endpoint", 500);
  }
});

// ─── POST /portal/api-keys/regenerate ────────────────────────────────────────

portalRouter.post("/api-keys/regenerate", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const parsed = apiKeyRegenerateSchema.safeParse(req.body);
    const name = (parsed.success && parsed.data.name) ? parsed.data.name : "Default";

    const key = ids.apiKey(false); // test keys only in beta
    const keyHash = hmacKey(key);
    const keyPrefix = key.slice(0, 16); // e.g. "test_a1b2c3d4e5f6"

    await prisma.merchant.update({
      where: { id: dbId },
      data: { testKeyHash: keyHash, testKeyName: name, testKeyPrefix: keyPrefix },
    });

    return ok(res, { key, name, prefix: keyPrefix });
  } catch (e) {
    console.error("[portal/api-keys/regenerate]", e);
    return err(res, "Failed to generate API key", 500);
  }
});
