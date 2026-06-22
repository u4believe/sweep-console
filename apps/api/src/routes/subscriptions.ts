import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { verifyApiKey, type AuthedRequest } from "../middleware/auth";
import { ok, err } from "../lib/response";
import { fireWebhook } from "../lib/webhooks/delivery";
import { ids } from "../lib/ids";
import { refundOnChain } from "../lib/chain/subscription";
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

  // Cancel on-chain (stops renewals + returns escrow), flip the sub to cancelled,
  // and revoke its renewal delegations — the shared single-active-sub kill switch.
  // A merchant-initiated cancel surfaces an on-chain failure as a 502.
  let result;
  try {
    result = await revokeSubscription(sub, merchant.merchantId, {
      reason: cancel_reason ?? "cancelled",
      throwOnChainError: true,
    });
  } catch (e) {
    console.error(`[subscriptions/cancel] on-chain cancel failed for ${sub.subscriptionId}:`, e);
    return err(res, "On-chain cancellation failed. Try again shortly.", 502);
  }

  return ok(res, {
    id: sub.subscriptionId,
    status: "cancelled",
    refunded_escrow: Number(result.refundedEscrow),
    tx_hash: result.cancelTxHash,
  });
});

// ─── POST /:id/refund ─────────────────────────────────────────────────────────
// The settlement window is the ONLY refund path: refund(refundPct) operates on
// USDC still held in escrow. Funds already pushed to the merchant's payout
// address cannot be recovered by the platform.

const refundSchema = z.object({
  refund_pct: z.number().int().min(1).max(100),
});

subscriptionsRouter.post("/:id/refund", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const sub = await prisma.subscription.findFirst({
    where: { subscriptionId: req.params.id as string, merchantId: merchant.id },
    include: { plan: true },
  });
  if (!sub) return err(res, "Subscription not found", 404, "not_found");
  if (!sub.onChainSubId) return err(res, "Subscription has no on-chain record", 409);

  const parsedBody = refundSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) return err(res, "refund_pct must be an integer between 1 and 100", 422);
  const { refund_pct } = parsedBody.data;

  if (sub.escrowBalance <= 0n) {
    return err(
      res,
      "Nothing left in escrow. The settlement window has closed and funds were pushed to the merchant.",
      409,
      "escrow_empty"
    );
  }

  try {
    const result = await refundOnChain(sub.onChainSubId, refund_pct);
    const remaining = sub.escrowBalance - result.refundedAmount;

    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: sub.id },
        data: {
          escrowBalance: remaining,
          ...(remaining === 0n ? { settlementDeadline: null } : {}),
        },
      }),
      prisma.payment.create({
        data: {
          paymentId: ids.payment(),
          merchantId: merchant.id,
          subscriptionId: sub.id,
          amount: result.refundedAmount,
          currency: sub.plan.currency,
          status: "succeeded",
          type: "refund",
          isTestMode: sub.isTestMode,
          txHash: result.txHash,
          blockNumber: result.blockNumber,
          chain: "arc",
        },
      }),
      // A fully refunded first payment will never settle — close out its record
      ...(refund_pct === 100
        ? [
            prisma.payment.updateMany({
              where: { subscriptionId: sub.id, status: "pending", type: "initial" },
              data: { status: "refunded" },
            }),
          ]
        : []),
    ]);

    await fireWebhook(merchant.id, sub.externalRef, merchant.merchantId, "payment.refunded", {
      subscription_id: sub.subscriptionId,
      plan_id: sub.plan.planId,
      refund_pct,
      amount: Number(result.refundedAmount),
      currency: sub.plan.currency,
      tx_hash: result.txHash,
      block_number: Number(result.blockNumber),
      chain: "arc",
    });

    return ok(res, {
      id: sub.subscriptionId,
      refund_pct,
      refunded_amount: Number(result.refundedAmount),
      remaining_escrow: Number(remaining),
      tx_hash: result.txHash,
    });
  } catch (e) {
    console.error(`[subscriptions/refund] failed for ${sub.subscriptionId}:`, e);
    return err(res, "On-chain refund failed. Try again shortly.", 502);
  }
});
