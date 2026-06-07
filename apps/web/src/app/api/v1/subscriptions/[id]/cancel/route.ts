import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err, notFound } from "@/lib/api/response";
import { cancelOnChain } from "@/lib/chain/subscription";
import { fireWebhook } from "@/lib/webhooks/delivery";
import { ids } from "@/lib/ids";

const cancelSchema = z.object({
  cancel_reason: z.string().max(500).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { id } = await params;
  const sub = await prisma.subscription.findFirst({
    where: { subscriptionId: id, merchantId: auth.merchant.id },
    include: { plan: true },
  });
  if (!sub) return notFound("Subscription");

  if (sub.status === "cancelled") {
    return err("Subscription is already cancelled", 409);
  }

  const body = await req.json().catch(() => ({}));
  const { cancel_reason } = cancelSchema.parse(body);

  // Cancel on-chain if we have the contract reference
  let cancelTxHash: string | undefined;
  if (sub.onChainSubId && sub.contractAddress) {
    try {
      cancelTxHash = await cancelOnChain(
        sub.onChainSubId as `0x${string}`,
        sub.isTestMode
      );
    } catch {
      // Log but don't block — off-chain state is authoritative for the developer
    }
  }

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: cancel_reason,
    },
    include: { plan: true },
  });

  // Record cancellation payment event
  await prisma.payment.create({
    data: {
      paymentId: ids.payment(),
      merchantId: auth.merchant.id,
      subscriptionId: sub.id,
      amount: 0n,
      currency: sub.plan.currency,
      status: "succeeded",
      type: "refund",
      isTestMode: sub.isTestMode,
      txHash: cancelTxHash,
      chain: "arc",
    },
  });

  await fireWebhook(
    auth.merchant.id,
    sub.externalRef,
    auth.merchant.merchantId,
    "subscription.cancelled",
    {
      subscription_id: updated.subscriptionId,
      plan_id: updated.plan.planId,
      cancel_reason: updated.cancelReason,
      wallet_address: updated.walletAddress,
      cancelled_at: updated.cancelledAt?.toISOString(),
    }
  );

  return ok({ id: updated.subscriptionId, status: updated.status });
}
