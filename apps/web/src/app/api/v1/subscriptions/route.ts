import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err } from "@/lib/api/response";

export async function GET(req: NextRequest) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const planId = searchParams.get("plan_id");
  const externalRef = searchParams.get("external_ref");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 100);
  const offset = parseInt(searchParams.get("offset") ?? "0");

  const plan = planId
    ? await prisma.plan.findFirst({ where: { planId, merchantId: auth.merchant.id } })
    : null;

  const subs = await prisma.subscription.findMany({
    where: {
      merchantId: auth.merchant.id,
      ...(status && { status }),
      ...(plan && { planId: plan.id }),
      ...(externalRef && { externalRef }),
    },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });

  const total = await prisma.subscription.count({
    where: {
      merchantId: auth.merchant.id,
      ...(status && { status }),
      ...(plan && { planId: plan.id }),
      ...(externalRef && { externalRef }),
    },
  });

  return ok({ data: subs.map(serializeSubscription), count: subs.length, total });
}

export function serializeSubscription(sub: {
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
