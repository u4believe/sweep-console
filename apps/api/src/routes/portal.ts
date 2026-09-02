import { Router } from "express";
import { z } from "zod";
import { createHmac, randomBytes } from "crypto";
import { addMinutes } from "date-fns";
import { verifyMessage } from "viem";
import type { Prisma } from "@prisma/client";
import { prisma, withRetry } from "../lib/prisma";
import { ids } from "../lib/ids";
import { ok, created, err, validationError } from "../lib/response";
import { sendEmail, payoutWalletEmailHtml } from "../lib/email";
import { verifyPortalSession } from "../middleware/portalAuth";
import type { PortalRequest } from "../middleware/portalAuth";
import { closePlanSubscriptions, findSubsToClose } from "../lib/plan-lifecycle";
import { requireStepUp } from "../lib/portal/stepup";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS } from "../lib/webhooks/events";
import { assertDeliverableUrl, WebhookUrlError } from "../lib/webhooks/url-guard";
import { securityRouter } from "./portal-security";
import { INTERVAL_SECONDS } from "../lib/checkout/complete";

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

// Enrolment, recovery codes, and the challenge/verify pair that requireStepUp
// below sends clients to when it answers 401 step_up_required.
portalRouter.use("/security", securityRouter);

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
//
// Deliberately does NOT return Merchant.webhookSecret. Deliveries are signed
// with the PER-ENDPOINT secret (WebhookEndpoint.secret — see lib/webhooks/
// delivery.ts), so the merchant-level one signs nothing; Settings used to
// display it beside a verification snippet, which would reject every event a
// merchant checked with it. Don't ship a credential-shaped value to the
// browser that no receiver can use.

portalRouter.get("/me", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: dbId },
      select: {
        merchantId: true,
        name: true,
        email: true,
        walletAddress: true,
        walletType: true,
        addressVerifiedAt: true,
        pendingWalletAddress: true,
        isLive: true,
        createdAt: true,
      },
    });
    return ok(res, { data: merchant });
  } catch (e) {
    console.error("[portal/me]", e);
    return err(res, "Failed to load profile", 500);
  }
});

// ─── GET/POST /portal/plans ───────────────────────────────────────────────────

/// The loosely-typed bag on Plan.metadata that carries the default tier's
/// presentation. Mirrors the reader in routes/public.ts.
function planMeta(metadata: unknown): { defaultTierName?: string; defaultFeatures?: string[] } | null {
  return (metadata as { defaultTierName?: string; defaultFeatures?: string[] } | null) ?? null;
}

/// Seconds in each billing interval, for normalising to a monthly run-rate.
const MONTH_SECONDS = INTERVAL_SECONDS.monthly;

/// One period's amount as a monthly run-rate, in USDC micro-units.
function monthlyMicro(amountMicro: bigint, interval: string): number {
  return Number(amountMicro) * (MONTH_SECONDS / (INTERVAL_SECONDS[interval] ?? MONTH_SECONDS));
}

portalRouter.get("/plans", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;
  try {
    const plans = await prisma.plan.findMany({
      where: { merchantId: dbId, archived: false },
      orderBy: { createdAt: "desc" },
      include: {
        // Live subscriptions only, carrying the amount/interval each one was
        // actually sold at. An unfiltered `_count` counted cancelled, past-due
        // and expired subscriptions as paying, and pricing MRR off the plan's
        // default ignored tiers entirely — together those overstated MRR by 83%
        // across this database, and by 600 USDC/month on a merchant whose
        // subscriptions were ALL cancelled.
        subscriptions: {
          where: { status: { in: ["active", "trialing"] } },
          select: { amount: true, interval: true },
        },
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
        subscribers: p.subscriptions.length,
        // Computed here, not in the browser: only the server sees each
        // subscription's own amount and interval, which is what a plan with
        // tiers is actually earning.
        mrr: p.subscriptions.reduce(
          (sum, s) => sum + monthlyMicro(s.amount ?? p.amount, s.interval ?? p.interval),
          0
        ),
        default_tier_name: planMeta(p.metadata)?.defaultTierName ?? null,
        // The default tier's feature list, so the portal's plan preview can show
        // the same card the checkout renders (public.ts serves it as defaultFeatures).
        default_features: planMeta(p.metadata)?.defaultFeatures ?? null,
        recommended_tier_id: p.recommendedTierId,
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
portalRouter.delete("/plans/:id", requireStepUp("plan.delete"), async (req, res) => {
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

// ─── Recommended tier ─────────────────────────────────────────────────────────
// Which tier checkout badges. Presentational only: it changes no price, no
// interval, and no existing subscription — and every other tier stays buyable.
// "default" marks the plan's own terms, which have no PlanTier row; null clears
// the badge entirely.
const recommendedSchema = z.object({
  recommended_tier_id: z.string().min(1).nullable(),
});

portalRouter.patch("/plans/:id/recommended", async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;
  const parsed = recommendedSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "recommended_tier_id must be a tier id, \"default\", or null", 422);

  try {
    const plan = await prisma.plan.findFirst({
      where: { planId: req.params.id as string, merchantId: dbId, archived: false },
      include: { tiers: { where: { archived: false }, select: { id: true } } },
    });
    if (!plan) return err(res, "Plan not found", 404);

    const wanted = parsed.data.recommended_tier_id;
    // Only a live tier on THIS plan can be recommended — otherwise checkout
    // would badge nothing and the setting would look silently broken.
    if (wanted !== null && wanted !== "default" && !plan.tiers.some((t) => t.id === wanted)) {
      return err(res, "That tier does not belong to this plan", 404);
    }

    await prisma.plan.update({ where: { id: plan.id }, data: { recommendedTierId: wanted } });
    return ok(res, { recommended_tier_id: wanted });
  } catch (e) {
    console.error("[portal/plans recommended PATCH]", e);
    return err(res, "Failed to set the recommended tier", 500);
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

// A tier's PRICE, INTERVAL and TRIAL are its billing terms: subscriptions snapshot
// them at checkout, and the checkout page sells against them. They are immutable
// for the life of the tier — to sell different terms, add another tier.
//
// What remains is presentation and applies from the next checkout onward, so it
// can be corrected in place: the tier's name and its feature copy. Editing one
// tier never touches any other.
const updateTierSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    features: z.array(z.string().max(200)).max(20).optional(),
  })
  .strict() // surfaces an attempt to edit a locked term instead of ignoring it
  .refine((d) => Object.keys(d).length > 0, { message: "No editable fields provided" });

/// The billing terms, named in the refusal so the caller knows which field was
/// rejected rather than getting a bare "unrecognized key".
const LOCKED_TIER_TERMS = ["amount", "interval", "trial_days"];

function lockedTermIn(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  return LOCKED_TIER_TERMS.find((k) => k in (body as Record<string, unknown>)) ?? null;
}

portalRouter.patch("/plans/:id/tiers/:tierId", async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;

  const locked = lockedTermIn(req.body);
  if (locked) {
    return err(
      res,
      `A tier's price, interval and trial are fixed once it exists (${locked}). Add a new tier to sell different terms.`,
      422
    );
  }

  const parsed = updateTierSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }

  try {
    const plan = await prisma.plan.findFirst({
      where: { planId: req.params.id as string, merchantId: dbId, archived: false },
      select: { id: true },
    });
    if (!plan) return err(res, "Plan not found", 404);

    const d = parsed.data;
    // Scope the update by planId too, so a tierId from another merchant's plan
    // can't be written through this route.
    const result = await prisma.planTier.updateMany({
      where: { id: req.params.tierId as string, planId: plan.id, archived: false },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.features !== undefined ? { features: d.features as Prisma.InputJsonValue } : {}),
      },
    });
    if (result.count === 0) return err(res, "Tier not found", 404);

    const tier = await prisma.planTier.findUnique({ where: { id: req.params.tierId as string } });
    return ok(res, {
      id: tier!.id,
      name: tier!.name,
      amount: Number(tier!.amount),
      interval: tier!.interval,
      trial_days: tier!.trialDays,
      features: tier!.features ?? null,
    });
  } catch (e) {
    console.error("[portal/plans tiers PATCH]", e);
    return err(res, "Failed to update tier", 500);
  }
});

// The DEFAULT tier is the plan's own terms — there is no PlanTier row behind it,
// so it is edited here rather than through /tiers/:tierId. Same contract as a
// tier: name, trial length and feature copy are presentation and editable; price
// and interval are the billing terms and are fixed once the plan exists.
//
// The name and features live on plan.metadata (defaultTierName / defaultFeatures,
// which is where the checkout reads them from); the trial is a real plan column.
portalRouter.patch("/plans/:id/default-tier", async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;

  const locked = lockedTermIn(req.body);
  if (locked) {
    return err(
      res,
      `The default tier's price, interval and trial are the plan's own terms and are fixed (${locked}). Add a tier to sell different terms.`,
      422
    );
  }

  const parsed = updateTierSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }

  try {
    const plan = await prisma.plan.findFirst({
      where: { planId: req.params.id as string, merchantId: dbId, archived: false },
      select: { id: true, metadata: true },
    });
    if (!plan) return err(res, "Plan not found", 404);

    const d = parsed.data;
    // Merge, don't replace: metadata carries keys this route knows nothing about.
    const metadata = {
      ...((plan.metadata as Record<string, unknown> | null) ?? {}),
      ...(d.name !== undefined ? { defaultTierName: d.name } : {}),
      ...(d.features !== undefined ? { defaultFeatures: d.features } : {}),
    };

    const updated = await prisma.plan.update({
      where: { id: plan.id },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });

    const meta = planMeta(updated.metadata);
    return ok(res, {
      id: "default",
      name: meta?.defaultTierName ?? updated.name,
      amount: Number(updated.amount),
      interval: updated.interval,
      trial_days: updated.trialDays,
      features: meta?.defaultFeatures ?? null,
    });
  } catch (e) {
    console.error("[portal/plans default-tier PATCH]", e);
    return err(res, "Failed to update the default tier", 500);
  }
});

// Archive a tier (append-only model: tiers aren't edited, only retired). Existing
// subscriptions snapshot their terms, so archiving never changes a live sub.
portalRouter.delete("/plans/:id/tiers/:tierId", requireStepUp("tier.delete"), async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;
  try {
    const plan = await prisma.plan.findFirst({
      where: { planId: req.params.id as string, merchantId: dbId },
      select: { id: true, recommendedTierId: true },
    });
    if (!plan) return err(res, "Plan not found", 404);
    const tierId = req.params.tierId as string;
    await prisma.planTier.updateMany({
      where: { id: tierId, planId: plan.id },
      data: { archived: true },
    });
    // Retiring the recommended tier must clear the badge too — otherwise the
    // plan points at an archived tier and checkout silently badges nothing.
    if (plan.recommendedTierId === tierId) {
      await prisma.plan.update({ where: { id: plan.id }, data: { recommendedTierId: null } });
    }
    return ok(res, { archived: true, recommended_cleared: plan.recommendedTierId === tierId });
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

/**
 * Payment history for the signed-in merchant.
 *
 * `?days=N` scopes to the last N days and `?limit=N` raises the row cap. Both
 * exist for the dashboard chart: a flat `take: 100` silently truncates the
 * series once a merchant has more than 100 payments, so the chart would under-
 * report settled value without saying so — and the wider the window, the worse
 * it gets. Callers that pass neither (the Payments table) keep the old
 * behaviour exactly.
 */
portalRouter.get("/payments", async (req, res) => {
  const dbId = (req as PortalRequest).merchantDbId;

  const days = Number(req.query.days);
  const scopedDays = Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 1), 90) : null;

  const limit = Number(req.query.limit);
  const take = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 2000) : 100;

  try {
    const payments = await prisma.payment.findMany({
      where: {
        merchantId: dbId,
        ...(scopedDays
          ? { createdAt: { gte: new Date(Date.now() - scopedDays * 86_400_000) } }
          : {}),
      },
      include: { subscription: { include: { plan: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take,
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
      available_events: WEBHOOK_EVENTS.map((e) => ({ id: e, description: WEBHOOK_EVENT_DESCRIPTIONS[e] })),
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
// additionally requires step-up auth (see lib/portal/stepup.ts).

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
// Setting the FIRST payout address is not a step-up action — there is nothing
// yet to redirect, and the merchant doing it is mid-onboarding. Changing an
// address that already receives money is, so the gate is conditional. This is
// the same line the old password prompt drew.
const stepUpForWalletChange = requireStepUp("wallet.change");

portalRouter.post(
  "/wallet/external",
  async (req, res, next) => {
    const dbId = (req as PortalRequest).merchantDbId;
    const merchant = await prisma.merchant.findUnique({
      where: { id: dbId },
      select: { walletAddress: true },
    });
    if (!merchant?.walletAddress) return next();
    return stepUpForWalletChange(req, res, next);
  },
  async (req, res) => {
    const dbId = (req as PortalRequest).merchantDbId;
    const address = (req.body.walletAddress as string | undefined)?.trim();

    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return err(res, "Invalid wallet address. Must be a 0x-prefixed 20-byte hex string.", 400);
    }

    // Ownership of the account is proven by requireStepUp above, not by a
    // password: accounts created through Google have passwordHash: null and
    // could never have satisfied a password prompt, so the old check locked
    // exactly the merchants it was meant to protect out of their own payouts.
    try {
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
  }
);

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
      subject: "Your Sweep Console payout wallet was updated",
      html: payoutWalletEmailHtml(merchant.name, merchant.pendingWalletAddress),
      text: `Your Sweep Console payout wallet was verified and set to ${merchant.pendingWalletAddress}. If you did not make this change, reset your password immediately and turn on an authenticator app.`,
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

portalRouter.post("/wallet/unlink", requireStepUp("wallet.unlink"), async (req, res) => {
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

portalRouter.post("/wallet/relink-circle", requireStepUp("wallet.change"), async (req, res) => {
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

portalRouter.post("/wallet/circle/withdraw", requireStepUp("payout.withdraw"), async (req, res) => {
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

const createWebhookSchema = z.object({
  // Shape only. Whether we are willing to POST there is decided by
  // assertDeliverableUrl below, which resolves the host — zod cannot do DNS.
  url: z.string().url("Must be a valid URL").max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Select at least one event"),
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

  // Registering an endpoint makes this server dial an address the merchant
  // chose — see lib/webhooks/url-guard.ts.
  try {
    await assertDeliverableUrl(url);
  } catch (e) {
    if (e instanceof WebhookUrlError) return validationError(res, { url: e.message });
    throw e;
  }

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

// ─── Webhook signing secrets ─────────────────────────────────────────────────
//
// Each endpoint carries its own secret, and it is what actually signs deliveries
// (lib/webhooks/delivery.ts). It is a bearer credential: anyone holding it can
// forge events into the merchant's system, so it is never included in the
// endpoint listing — it is fetched deliberately, one endpoint at a time, behind
// a confirmation.

portalRouter.post("/webhooks/:id/secret", requireStepUp("webhook.reveal"), async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;
  try {
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { endpointId: req.params.id as string, merchantId: dbId, isActive: true },
      select: { secret: true },
    });
    if (!endpoint) return err(res, "Endpoint not found", 404);
    return ok(res, { secret: endpoint.secret });
  } catch (e) {
    console.error("[portal/webhooks secret]", e);
    return err(res, "Failed to read signing secret", 500);
  }
});

/// Replaces the secret. Deliveries signed with the old one stop verifying the
/// moment this returns, so the client asks first and hands back the new value
/// once — there is no undo and no second copy.
portalRouter.post("/webhooks/:id/roll", requireStepUp("webhook.roll"), async (req, res) => {
  const dbId = (req as unknown as PortalRequest).merchantDbId;
  try {
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { endpointId: req.params.id as string, merchantId: dbId, isActive: true },
      select: { id: true },
    });
    if (!endpoint) return err(res, "Endpoint not found", 404);

    const secret = `whsec_${randomBytes(24).toString("hex")}`;
    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { secret } });
    return ok(res, { secret });
  } catch (e) {
    console.error("[portal/webhooks roll]", e);
    return err(res, "Failed to roll signing secret", 500);
  }
});

// ─── POST /portal/api-keys/regenerate ────────────────────────────────────────

portalRouter.post("/api-keys/regenerate", requireStepUp("apikey.regenerate"), async (req, res) => {
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
