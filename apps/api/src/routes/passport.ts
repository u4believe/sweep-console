import { Router } from "express";
import { z } from "zod";
import { createHmac } from "crypto";
import { addDays } from "date-fns";
import { prisma } from "../lib/prisma";
import { verifyApiKey, type AuthedRequest } from "../middleware/auth";
import { ok, err, validationError } from "../lib/response";
import { ids } from "../lib/ids";
import { fireWebhook } from "../lib/webhooks/delivery";

export const passportRouter = Router();

const activateSchema = z.object({
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"),
  plan_id: z.string(),
  external_ref: z.string().min(1).max(255),
  wallet_signature: z.string(),
  tx_hash: z.string().optional(),
  block_number: z.number().optional(),
});

passportRouter.post("/activate", verifyApiKey, async (req, res) => {
  const { merchant, isTestMode } = req as AuthedRequest;
  const parsed = activateSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }

  const { wallet_address, plan_id, external_ref, tx_hash, block_number } = parsed.data;
  const normalizedWallet = wallet_address.toLowerCase();

  const plan = await prisma.plan.findFirst({
    where: { planId: plan_id, merchantId: merchant.id, archived: false },
  });
  if (!plan) return err(res, "Plan not found", 404, "not_found");

  let passport = await prisma.passport.findUnique({ where: { walletAddress: normalizedWallet } });

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
    return err(res, "Passport has been revoked. Please reconnect your wallet.", 403);
  }

  const now = new Date();
  const intervalDays: Record<string, number> = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
  const days = intervalDays[plan.interval] ?? 30;
  const hasTrial = plan.trialDays > 0;
  const periodEnd = hasTrial ? addDays(now, plan.trialDays) : addDays(now, days);

  const subscription = await prisma.subscription.create({
    data: {
      subscriptionId: ids.subscription(),
      merchantId: merchant.id,
      planId: plan.id,
      externalRef: external_ref,
      walletAddress: normalizedWallet,
      status: hasTrial ? "trialing" : "active",
      activationMethod: "passport",
      isTestMode,
      activationTxHash: tx_hash,
      currentPeriodStart: now,
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
        merchantId: merchant.id,
        subscriptionId: subscription.id,
        amount: plan.amount,
        currency: plan.currency,
        status: "succeeded",
        type: "initial",
        isTestMode,
        txHash: tx_hash,
        blockNumber: block_number ? BigInt(block_number) : null,
        chain: "arc",
      },
    });
  }

  await fireWebhook(merchant.id, external_ref, merchant.merchantId, "passport.activated", {
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
  });

  return ok(res, {
    subscription_id: subscription.subscriptionId,
    status: subscription.status,
    passport_id: passport.passportId,
    current_period_end: periodEnd.toISOString(),
  });
});

passportRouter.get("/status", verifyApiKey, async (req, res) => {
  const walletAddress = req.query.wallet_address as string | undefined;
  if (!walletAddress) return err(res, "wallet_address query parameter is required", 400);

  const passport = await prisma.passport.findUnique({
    where: { walletAddress: walletAddress.toLowerCase() },
  });

  if (!passport || !passport.isValid) {
    return ok(res, { has_passport: false, passport: null });
  }

  return ok(res, {
    has_passport: true,
    passport: {
      id: passport.passportId,
      wallet_address: passport.walletAddress,
      issued_at: passport.issuedAt.toISOString(),
    },
  });
});
