import { Router } from "express";
import { prisma } from "../lib/prisma";
import { verifyApiKey, type AuthedRequest } from "../middleware/auth";
import { ok, err } from "../lib/response";

export const paymentsRouter = Router();

function serializePayment(p: {
  paymentId: string; amount: bigint; currency: string; status: string;
  type: string; txHash: string | null; blockNumber: bigint | null;
  chain: string; failureReason: string | null; isTestMode: boolean; createdAt: Date;
}) {
  return {
    id: p.paymentId,
    amount: Number(p.amount),
    currency: p.currency,
    status: p.status,
    type: p.type,
    tx_hash: p.txHash,
    block_number: p.blockNumber ? Number(p.blockNumber) : null,
    chain: p.chain,
    failure_reason: p.failureReason,
    test_mode: p.isTestMode,
    created_at: p.createdAt.toISOString(),
  };
}

paymentsRouter.get("/", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const { subscription_id, status, limit: limitStr, offset: offsetStr } = req.query as Record<string, string>;
  const limit = Math.min(parseInt(limitStr ?? "20"), 100);
  const offset = parseInt(offsetStr ?? "0");

  const sub = subscription_id
    ? await prisma.subscription.findFirst({ where: { subscriptionId: subscription_id, merchantId: merchant.id } })
    : null;

  const payments = await prisma.payment.findMany({
    where: {
      merchantId: merchant.id,
      ...(sub && { subscriptionId: sub.id }),
      ...(status && { status }),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });

  return ok(res, { data: payments.map(serializePayment), count: payments.length });
});

paymentsRouter.get("/:id", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const payment = await prisma.payment.findFirst({
    where: { paymentId: req.params.id as string, merchantId: merchant.id },
  });
  if (!payment) return err(res, "Payment not found", 404, "not_found");
  return ok(res, serializePayment(payment));
});
