// Shared checkout-completion logic.
//
// Both activation paths end here once subscribe() has landed on Arc:
//   - "wallet": the subscriber signed approve() + subscribe() directly on Arc
//     (POST /internal/checkout/confirm)
//   - "gateway": the Gateway orchestrator activated cross-chain via
//     subscribeViaGateway() (mint + permit + subscribe in one tx)
//
// The on-chain subscription is re-verified before anything is recorded, and
// every merchant webhook carries external_ref + tx_hash + block_number.

import { addDays } from "date-fns";
import { prisma } from "../prisma";
import { ids } from "../ids";
import { fireWebhook } from "../webhooks/delivery";
import { getManagerAddress, getOnChainSubscription } from "../chain/subscription";
import { resolveCheckoutCustomer } from "./identity";
import { resolveTier } from "./tiers";
import { retirePriorActiveSubscriptions } from "../subscriptions/revoke";
import type { CheckoutSession, Merchant, Plan } from "@prisma/client";

export const INTERVAL_SECONDS: Record<string, number> = {
  daily: 86_400,
  weekly: 604_800,
  monthly: 2_592_000, // 30 days
  yearly: 31_536_000, // 365 days
};

const INTERVAL_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };

export interface CompleteCheckoutInput {
  session: CheckoutSession & { plan: Plan; merchant: Merchant };
  walletAddress: string;
  activationMethod: "wallet" | "gateway" | "cctp";
  /// Email the subscriber entered (only needed when linking a NEW wallet)
  email?: string | null;
  /// Signed OTP proof that the email is verified (required to link a new wallet)
  emailToken?: string | null;
  txHash?: string | null;
  allowanceTxHash?: string | null;
  blockNumber?: number | null;
}

export class CheckoutVerificationError extends Error {
  constructor(message: string, public httpStatus: number) {
    super(message);
  }
}


/// Verifies the subscription on-chain, records it (subscription + payment +
/// passport + session complete) and fires the merchant webhooks.
export async function completeCheckoutSession(input: CompleteCheckoutInput) {
  const { session, walletAddress, activationMethod, email, emailToken, txHash, allowanceTxHash, blockNumber } = input;

  // A plan closed (deleted) mid-checkout can't be activated.
  if (session.plan.archived) {
    throw new CheckoutVerificationError("This plan is no longer available.", 409);
  }

  // Resolve the email-anchored customer: a known wallet recalls its customer
  // (no token); a new wallet links to a verified-email customer via the OTP
  // proof. A verified link is REQUIRED — no link, no activation.
  const customer = await resolveCheckoutCustomer({
    merchantId: session.merchantId,
    walletAddress,
    email,
    emailToken,
  });
  if (!customer) {
    throw new CheckoutVerificationError(
      "Verify your email before activating your subscription.",
      403
    );
  }
  const normalizedEmail = customer.email;

  // Don't trust the caller — confirm subscribe() actually landed on-chain for
  // this session ID and wallet before recording anything.
  const onChainSubId = ids.toBytes32(session.sessionId);
  let onChain;
  try {
    onChain = await getOnChainSubscription(onChainSubId);
  } catch (e) {
    console.error("[checkout/complete] on-chain read failed:", e);
    throw new CheckoutVerificationError(
      "Could not verify the subscription on-chain. Try again shortly.",
      502
    );
  }
  if (onChain.status === 0) {
    throw new CheckoutVerificationError("Subscription not found on-chain for this session", 409);
  }
  if (onChain.subscriber.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new CheckoutVerificationError(
      "On-chain subscriber does not match the connected wallet",
      409
    );
  }

  const plan = session.plan;
  // Effective terms come from the chosen tier (or the plan's default tier).
  const tier = await resolveTier(plan, session.tierId);
  // The on-chain subscription committed an amount — it must match the chosen tier.
  if (onChain.amount !== tier.amount) {
    throw new CheckoutVerificationError("On-chain amount does not match the selected tier", 409);
  }
  const hasTrial = tier.trialDays > 0;
  const days = INTERVAL_DAYS[tier.interval] ?? 30;
  const now = new Date();
  const periodEnd = hasTrial ? addDays(now, tier.trialDays) : addDays(now, days);

  // Mirror the contract's settlement-window escrow: the first payment stays in
  // escrow until the billing engine's settleDuePeriods() pushes it out.
  const escrowBalance = onChain.escrowBalance;
  const settlementDeadline =
    onChain.settlementDeadline > 0n ? new Date(Number(onChain.settlementDeadline) * 1000) : null;

  const subscription = await prisma.subscription.create({
    data: {
      subscriptionId: ids.subscription(),
      merchantId: session.merchantId,
      planId: plan.id,
      // Snapshot the chosen tier's terms so they're immutable for this sub and the
      // billing engine never re-reads a mutated/closed plan.
      amount: tier.amount,
      interval: tier.interval,
      externalRef: session.externalRef,
      walletAddress: walletAddress.toLowerCase(),
      subscriberEmail: normalizedEmail,
      customerId: customer?.customerDbId ?? null,
      status: hasTrial ? "trialing" : "active",
      activationMethod,
      isTestMode: session.isTestMode,
      onChainSubId,
      contractAddress: getManagerAddress(),
      allowanceTxHash: allowanceTxHash ?? null,
      activationTxHash: txHash ?? null,
      escrowBalance,
      settlementDeadline,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialStart: hasTrial ? now : null,
      trialEnd: hasTrial ? addDays(now, tier.trialDays) : null,
    },
  });

  // Link any renewal mandates granted during this checkout (bound to the session
  // at grant time) to the new subscription, so the delegated pass can redeem them.
  await prisma.renewalDelegation.updateMany({
    where: { sessionId: session.sessionId, subscriptionId: null },
    data: { subscriptionId: subscription.id },
  });

  // Enforce one active subscription per customer per merchant: retire any prior
  // active sub for this (email-anchored) customer. This is what makes an upgrade
  // atomic — the old plan's allowance + cross-chain delegation are revoked so it
  // can never bill alongside the new plan. Best-effort: a retire failure must not
  // undo the activation the subscriber just paid for.
  await retirePriorActiveSubscriptions({
    merchantId: session.merchantId,
    merchantPublicId: session.merchant.merchantId,
    customerDbId: customer.customerDbId,
    subscriberEmail: normalizedEmail,
    exceptSubscriptionId: subscription.id,
  });


  await prisma.payment.create({
    data: {
      paymentId: ids.payment(),
      merchantId: session.merchantId,
      subscriptionId: subscription.id,
      amount: hasTrial ? 0n : tier.amount,
      currency: plan.currency,
      // Escrowed first payments stay "pending" until settlement pushes them
      status: hasTrial ? "succeeded" : "pending",
      type: "initial",
      isTestMode: session.isTestMode,
      txHash: txHash ?? null,
      blockNumber: blockNumber ? BigInt(blockNumber) : null,
      chain: "arc",
    },
  });

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: { status: "complete", subscriptionId: subscription.subscriptionId },
  });

  await prisma.passport.upsert({
    where: { walletAddress: walletAddress.toLowerCase() },
    create: {
      passportId: ids.passport(),
      walletAddress: walletAddress.toLowerCase(),
      email: normalizedEmail,
      platformSig: ids.sessionToken(),
    },
    // Keep an existing email if this checkout didn't collect one
    update: { isValid: true, revokedAt: null, ...(normalizedEmail ? { email: normalizedEmail } : {}) },
  });

  const eventData = {
    subscription_id: subscription.subscriptionId,
    plan_id: plan.planId,
    plan_name: plan.name,
    tier_id: tier.tierId,
    tier_name: tier.tierName,
    amount: Number(tier.amount),
    currency: plan.currency,
    interval: tier.interval,
    status: subscription.status,
    activation_method: activationMethod,
    wallet_address: walletAddress.toLowerCase(),
    // Stable, email-anchored identity — constant across the customer's wallets
    customer_id: customer?.customerId ?? null,
    subscriber_email: normalizedEmail,
    tx_hash: txHash ?? null,
    allowance_tx_hash: allowanceTxHash ?? null,
    block_number: blockNumber ?? null,
    chain: "arc",
    current_period_end: periodEnd.toISOString(),
    trial_end: subscription.trialEnd?.toISOString() ?? null,
    settlement_deadline: settlementDeadline?.toISOString() ?? null,
  };

  await Promise.all([
    fireWebhook(session.merchantId, session.externalRef, session.merchant.merchantId,
      "checkout.session.completed", eventData),
    fireWebhook(session.merchantId, session.externalRef, session.merchant.merchantId,
      "subscription.created", eventData),
  ]);

  const redirectUrl = session.successUrl.includes("{SESSION_ID}")
    ? session.successUrl.replace("{SESSION_ID}", session.sessionId)
    : session.successUrl;

  return { subscription, redirectUrl };
}
