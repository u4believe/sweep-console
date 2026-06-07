import { NextRequest } from "next/server";
import { z } from "zod";
import { addDays } from "date-fns";
import { prisma } from "@/lib/prisma";
import { ok, err } from "@/lib/api/response";
import { ids } from "@/lib/ids";
import { fireWebhook } from "@/lib/webhooks/delivery";

// Called by the checkout UI after the subscriber's subscribe() tx is confirmed on-chain.
// This is an internal route — not part of the public API.

const confirmSchema = z.object({
  session_id: z.string(),
  tx_hash: z.string(),
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  block_number: z.number().optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid JSON body", 400);

  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) return err("Invalid payload", 422);

  const { session_id, tx_hash, wallet_address, block_number } = parsed.data;

  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId: session_id },
    include: { plan: true, merchant: true },
  });

  if (!session || session.status !== "open") {
    return err("Session not found or already complete", 404);
  }

  const plan = session.plan;
  const hasTrial = plan.trialDays > 0;
  const intervalDays = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
  const days = intervalDays[plan.interval as keyof typeof intervalDays] ?? 30;
  const now = new Date();
  const periodEnd = hasTrial ? addDays(now, plan.trialDays) : addDays(now, days);

  // Create subscription
  const subscription = await prisma.subscription.create({
    data: {
      subscriptionId: ids.subscription(),
      merchantId: session.merchantId,
      planId: plan.id,
      externalRef: session.externalRef,
      walletAddress: wallet_address.toLowerCase(),
      status: hasTrial ? "trialing" : "active",
      activationMethod: "wallet",
      isTestMode: session.isTestMode,
      onChainSubId: ids.toBytes32(session_id),
      activationTxHash: tx_hash,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialStart: hasTrial ? now : null,
      trialEnd: hasTrial ? addDays(now, plan.trialDays) : null,
    },
  });

  // Record initial payment
  await prisma.payment.create({
    data: {
      paymentId: ids.payment(),
      merchantId: session.merchantId,
      subscriptionId: subscription.id,
      amount: hasTrial ? 0n : plan.amount,
      currency: plan.currency,
      status: "succeeded",
      type: "initial",
      isTestMode: session.isTestMode,
      txHash: tx_hash,
      blockNumber: block_number ? BigInt(block_number) : null,
      chain: "arc",
    },
  });

  // Mark session complete and link subscription
  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: { status: "complete", subscriptionId: subscription.subscriptionId },
  });

  // Ensure/create passport for this wallet
  await prisma.passport.upsert({
    where: { walletAddress: wallet_address.toLowerCase() },
    create: {
      passportId: ids.passport(),
      walletAddress: wallet_address.toLowerCase(),
      platformSig: ids.sessionToken(), // simplified — production uses a real HMAC
    },
    update: { isValid: true, revokedAt: null },
  });

  // Fire webhooks
  const eventData = {
    subscription_id: subscription.subscriptionId,
    plan_id: plan.planId,
    plan_name: plan.name,
    amount: Number(plan.amount),
    currency: plan.currency,
    interval: plan.interval,
    status: subscription.status,
    activation_method: "wallet",
    wallet_address: wallet_address.toLowerCase(),
    tx_hash,
    block_number: block_number ?? null,
    chain: "arc",
    current_period_end: periodEnd.toISOString(),
    trial_end: subscription.trialEnd?.toISOString() ?? null,
  };

  await Promise.all([
    fireWebhook(session.merchantId, session.externalRef, session.merchant.merchantId,
      "checkout.session.completed", eventData),
    fireWebhook(session.merchantId, session.externalRef, session.merchant.merchantId,
      "subscription.created", eventData),
  ]);

  const successUrl = session.successUrl.includes("{SESSION_ID}")
    ? session.successUrl.replace("{SESSION_ID}", session_id)
    : session.successUrl;

  return ok({ subscription_id: subscription.subscriptionId, redirect_url: successUrl });
}
