import { NextRequest } from "next/server";
import { z } from "zod";
import { createHmac } from "crypto";
import { addDays } from "date-fns";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err, validationError } from "@/lib/api/response";
import { ids } from "@/lib/ids";
import { fireWebhook } from "@/lib/webhooks/delivery";

const activateSchema = z.object({
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"),
  plan_id: z.string(),
  external_ref: z.string().min(1).max(255),
  wallet_signature: z.string(), // EIP-712 signature proving ownership
  tx_hash: z.string().optional(), // on-chain transaction hash
  block_number: z.number().optional(),
});

export async function POST(req: NextRequest) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid JSON body", 400);

  const parsed = activateSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
      )
    );
  }

  const { wallet_address, plan_id, external_ref, tx_hash, block_number } = parsed.data;
  const normalizedWallet = wallet_address.toLowerCase();

  const plan = await prisma.plan.findFirst({
    where: { planId: plan_id, merchantId: auth.merchant.id, archived: false },
  });
  if (!plan) return err("Plan not found", 404);

  // Find or create passport
  let passport = await prisma.passport.findUnique({
    where: { walletAddress: normalizedWallet },
  });

  if (!passport) {
    const sig = createHmac("sha256", process.env.PLATFORM_API_SIGNING_SECRET ?? "")
      .update(`${normalizedWallet}:${Date.now()}`)
      .digest("hex");

    passport = await prisma.passport.create({
      data: {
        passportId: ids.passport(),
        walletAddress: normalizedWallet,
        platformSig: sig,
      },
    });
  } else if (!passport.isValid) {
    return err("Passport has been revoked. Please reconnect your wallet.", 403);
  }

  // Determine billing period from plan interval
  const now = new Date();
  const intervalDays = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
  const days = intervalDays[plan.interval as keyof typeof intervalDays] ?? 30;

  const hasTrial = plan.trialDays > 0;
  const periodStart = now;
  const periodEnd = hasTrial
    ? addDays(now, plan.trialDays)
    : addDays(now, days);

  const subscription = await prisma.subscription.create({
    data: {
      subscriptionId: ids.subscription(),
      merchantId: auth.merchant.id,
      planId: plan.id,
      externalRef: external_ref,
      walletAddress: normalizedWallet,
      status: hasTrial ? "trialing" : "active",
      activationMethod: "passport",
      isTestMode: auth.isTestMode,
      activationTxHash: tx_hash,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      trialStart: hasTrial ? now : null,
      trialEnd: hasTrial ? addDays(now, plan.trialDays) : null,
      passportId: passport.id,
    },
    include: { plan: true },
  });

  if (tx_hash) {
    await prisma.payment.create({
      data: {
        paymentId: ids.payment(),
        merchantId: auth.merchant.id,
        subscriptionId: subscription.id,
        amount: plan.amount,
        currency: plan.currency,
        status: "succeeded",
        type: "initial",
        isTestMode: auth.isTestMode,
        txHash: tx_hash,
        blockNumber: block_number ? BigInt(block_number) : null,
        chain: "arc",
      },
    });
  }

  await fireWebhook(
    auth.merchant.id,
    external_ref,
    auth.merchant.merchantId,
    "passport.activated",
    {
      subscription_id: subscription.subscriptionId,
      plan_id: plan.planId,
      plan_name: plan.name,
      amount: Number(plan.amount),
      currency: plan.currency,
      interval: plan.interval,
      status: subscription.status,
      activation_method: "passport_wallet",
      wallet_address: normalizedWallet,
      tx_hash: tx_hash ?? null,
      block_number: block_number ?? null,
      chain: "arc",
      current_period_end: periodEnd.toISOString(),
      trial_end: subscription.trialEnd?.toISOString() ?? null,
    }
  );

  return ok({
    subscription_id: subscription.subscriptionId,
    status: subscription.status,
    passport_id: passport.passportId,
    current_period_end: periodEnd.toISOString(),
  });
}
