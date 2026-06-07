import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err } from "@/lib/api/response";

export async function GET(req: NextRequest) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { searchParams } = new URL(req.url);
  const subscriptionId = searchParams.get("subscription_id");
  const status = searchParams.get("status");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 100);
  const offset = parseInt(searchParams.get("offset") ?? "0");

  const sub = subscriptionId
    ? await prisma.subscription.findFirst({
        where: { subscriptionId, merchantId: auth.merchant.id },
      })
    : null;

  const payments = await prisma.payment.findMany({
    where: {
      merchantId: auth.merchant.id,
      ...(sub && { subscriptionId: sub.id }),
      ...(status && { status }),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });

  return ok({ data: payments.map(serializePayment), count: payments.length });
}

export function serializePayment(p: {
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
