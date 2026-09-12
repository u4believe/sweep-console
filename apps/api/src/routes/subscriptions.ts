import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { verifyApiKey, type AuthedRequest } from "../middleware/auth";
import { ok, err } from "../lib/response";
import { fireWebhook } from "../lib/webhooks/delivery";
import { ids } from "../lib/ids";
import { revokeSubscription } from "../lib/subscriptions/revoke";

export const subscriptionsRouter = Router();

function serializeSubscription(sub: {
  subscriptionId: string; externalRef: string; walletAddress: string;
  status: string; activationMethod: string; isTestMode: boolean;
  activationTxHash: string | null; currentPeriodStart: Date; currentPeriodEnd: Date;
  trialStart: Date | null; trialEnd: Date | null; cancelledAt: Date | null;
  createdAt: Date; updatedAt: Date;
  plan: { planId: string; name: string; amount: bigint; currency: string; interval: string };
}) {
  return {
    id: sub.subscriptionId,
    external_ref: sub.externalRef,
    wallet_address: sub.walletAddress,
    status: sub.status,
    activation_method: sub.activationMethod,
    test_mode: sub.isTestMode,
    plan: {
      id: sub.plan.planId,
      name: sub.plan.name,
      amount: Number(sub.plan.amount),
      currency: sub.plan.currency,
      interval: sub.plan.interval,
    },
    tx_hash: sub.activationTxHash,
    current_period_start: sub.currentPeriodStart.toISOString(),
    current_period_end: sub.currentPeriodEnd.toISOString(),
    trial_start: sub.trialStart?.toISOString() ?? null,
    trial_end: sub.trialEnd?.toISOString() ?? null,
    cancelled_at: sub.cancelledAt?.toISOString() ?? null,
    created_at: sub.createdAt.toISOString(),
    updated_at: sub.updatedAt.toISOString(),
  };
}

subscriptionsRouter.get("/", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const { status, plan_id, external_ref, limit: limitStr, offset: offsetStr } = req.query as Record<string, string>;
  const limit = Math.min(parseInt(limitStr ?? "20"), 100);
  const offset = parseInt(offsetStr ?? "0");

  const plan = plan_id
    ? await prisma.plan.findFirst({ where: { planId: plan_id, merchantId: merchant.id } })
    : null;

  const where = {
    merchantId: merchant.id,
    ...(status && { status }),
    ...(plan && { planId: plan.id }),
    ...(external_ref && { externalRef: external_ref }),
  };

  const [subs, total] = await Promise.all([
    prisma.subscription.findMany({
      where, include: { plan: true }, orderBy: { createdAt: "desc" },
      take: limit, skip: offset,
    }),
    prisma.subscription.count({ where }),
  ]);

  return ok(res, { data: subs.map(serializeSubscription), count: subs.length, total });
});

subscriptionsRouter.get("/status", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const externalRef = req.query.external_ref as string | undefined;
  if (!externalRef) return err(res, "external_ref query parameter is required", 400);

  const sub = await prisma.subscription.findFirst({
    where: {
      merchantId: merchant.id,
      externalRef,
      status: { in: ["active", "trialing", "past_due"] },
    },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });

  if (!sub) return err(res, "Active subscription not found", 404, "not_found");
  return ok(res, serializeSubscription(sub));
});

subscriptionsRouter.get("/:id", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const sub = await prisma.subscription.findFirst({
    where: { subscriptionId: req.params.id as string, merchantId: merchant.id },
    include: { plan: true },
  });
  if (!sub) return err(res, "Subscription not found", 404, "not_found");
  return ok(res, serializeSubscription(sub));
});

const cancelSchema = z.object({
  cancel_reason: z.string().max(500).optional(),
});

subscriptionsRouter.post("/:id/cancel", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const sub = await prisma.subscription.findFirst({
    where: { subscriptionId: req.params.id as string, merchantId: merchant.id },
    include: { plan: true },
  });
  if (!sub) return err(res, "Subscription not found", 404, "not_found");
  if (sub.status === "cancelled") return err(res, "Subscription is already cancelled", 409);

  const { cancel_reason } = cancelSchema.parse(req.body ?? {});

  // Flip the sub to cancelled and revoke its renewal delegations — the shared
  // single-active-sub kill switch. No money moves: nothing is held in escrow, so
  // cancelling only removes future authority.
  let result;
  try {
    result = await revokeSubscription(sub, merchant.merchantId, {
      reason: cancel_reason ?? "cancelled",
    });
  } catch (e) {
    console.error(`[subscriptions/cancel] failed for ${sub.subscriptionId}:`, e);
    return err(res, "Failed to cancel subscription. Try again shortly.", 500);
  }

  return ok(res, {
    id: sub.subscriptionId,
    status: "cancelled",
    revoked_delegations: result.revokedDelegations,
  });
});

// ─── POST /:id/refund ─────────────────────────────────────────────────────────
// Retired. A charge settles straight into the merchant's payout wallet, so the
// platform never holds funds it could return. Kept as an explicit 409 so an
// existing integration gets a reason instead of a 404 that reads like a bug.

const refundSchema = z.object({
  refund_pct: z.number().int().min(1).max(100),
});

subscriptionsRouter.post("/:id/refund", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const sub = await prisma.subscription.findFirst({
    where: { subscriptionId: req.params.id as string, merchantId: merchant.id },
    select: { subscriptionId: true },
  });
  if (!sub) return err(res, "Subscription not found", 404, "not_found");

  // Refunds are gone with the settlement-window escrow they operated on. A charge
  // now settles by minting the merchant's share straight into their wallet, so
  // there is never a moment when this platform holds the money and could return
  // it. The endpoint stays so an existing integration gets a reason rather than a
  // 404 that reads like a bug.
  return err(
    res,
    "Refunds are no longer available. Payments settle directly to your payout wallet with no " +
      "escrow held, so there are no funds for this platform to return — refund the subscriber " +
      "from your wallet, and cancel the subscription to stop future charges.",
    409,
    "refunds_unavailable"
  );
});
