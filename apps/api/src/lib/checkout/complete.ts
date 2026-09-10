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
import { sendPaymentReceipt } from "../email/receipt";
import {
  getManagerAddress,
  getOnChainSubscription,
  cancelOnChain,
  describeChainError,
} from "../chain/subscription";
import { resolveCheckoutCustomer } from "./identity";
import { findWalletConflict, walletConflictMessage } from "./wallet-guard";
import { resolveTier } from "./tiers";
import { retirePriorActiveSubscriptions } from "../subscriptions/revoke";
import type { CheckoutSession, Merchant, Plan } from "@prisma/client";

/// The platform's cut, in basis points — the same figure delegated-renewal.ts and
/// cctp-activate.ts split with. Reported to the merchant so the event explains the
/// difference between what the subscriber paid and what arrived.
function platformFeeBps(): bigint {
  return BigInt(process.env.PLATFORM_FEE_BPS ?? "0");
}

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
  /**
   * The chain the subscriber's USDC actually came from. Omitted on the Arc paths,
   * where funds never leave Arc; set to the source chain ("base", "arbitrum", …)
   * on the cross-chain path, where the money is pulled there and bridged in.
   * Settlement is always Arc either way — this records where it was PAID from.
   */
  sourceChain?: string | null;
  /**
   * The PLATFORM settled this activation itself — it redeemed the delegation,
   * bridged the funds and minted them to the merchant, with no
   * SubscriptionManager call anywhere in the path.
   *
   * That changes what completion can and cannot do. There is nothing on-chain to
   * verify, because we are not taking an untrusted caller's word for it — we are
   * the actor. There is no escrow to mirror, because nothing was escrowed. And
   * there is no onChainSubId, because no on-chain subscription exists.
   */
  platformSettled?: boolean;
  /**
   * A Customer already resolved from a verified OTP proof by the caller. The
   * cross-chain path proves ownership synchronously (at /cross-chain/activate)
   * and then bridges detached, by which point the email token is gone — so it
   * hands the decision here rather than letting resolveCheckoutCustomer fall back
   * to the wallet link, which names whoever used that wallet at this merchant
   * first, not the person who just paid.
   */
  customerDbId?: string | null;
}

export class CheckoutVerificationError extends Error {
  constructor(message: string, public httpStatus: number) {
    super(message);
  }
}


/// Verifies the subscription on-chain, records it (subscription + payment +
/// session complete) and fires the merchant webhooks.
export async function completeCheckoutSession(input: CompleteCheckoutInput) {
  const { session, walletAddress, activationMethod, email, emailToken, txHash, allowanceTxHash, blockNumber } = input;
  const platformSettled = input.platformSettled ?? false;
  // Arc is both the settlement chain and the default funding chain.
  const paidFromChain = input.sourceChain ?? "arc";

  // A plan closed (deleted) mid-checkout can't be activated.
  if (session.plan.archived) {
    throw new CheckoutVerificationError("This plan is no longer available.", 409);
  }

  // Resolve the email-anchored customer: a known wallet recalls its customer
  // (no token); a new wallet links to a verified-email customer via the OTP
  // proof. A verified link is REQUIRED — no link, no activation.
  const customer = input.customerDbId
    ? await (async () => {
        const c = await prisma.customer.findUnique({ where: { id: input.customerDbId! } });
        return c ? { customerDbId: c.id, customerId: c.customerId, email: c.email } : null;
      })()
    : await resolveCheckoutCustomer({
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
  // this session ID and wallet before recording anything. This guard exists for
  // the DIRECT path, where the subscriber submits subscribe() themselves and the
  // server only hears about it afterwards.
  //
  // A platform-settled activation has no such claim to check: we redeemed the
  // delegation, we burned it, we minted it. Reading a contract that was never
  // called would only ever find nothing.
  const onChainSubId = platformSettled ? null : ids.toBytes32(session.sessionId);
  let onChain: Awaited<ReturnType<typeof getOnChainSubscription>> | null = null;
  if (onChainSubId) {
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
  }

  const plan = session.plan;
  // Effective terms come from the chosen tier (or the plan's default tier).
  const tier = await resolveTier(plan, session.tierId);
  // The on-chain subscription committed an amount — it must match the chosen tier.
  if (onChain && onChain.amount !== tier.amount) {
    throw new CheckoutVerificationError("On-chain amount does not match the selected tier", 409);
  }
  // Last-resort wallet guard. Every path that can pre-empt this checks before the
  // subscriber commits funds; the direct path cannot, because the subscriber
  // submits subscribe() themselves and we only hear about it here. So if a
  // conflict survives to this point, cancel on-chain — which returns the escrowed
  // first period to them in the same tx — before refusing.
  const conflict = await findWalletConflict({
    merchantId: session.merchantId,
    walletAddress,
    identity: { customerDbId: customer.customerDbId, email: normalizedEmail },
  });
  if (conflict) {
    // Platform-settled: the merchant already holds the money, and there is no
    // escrow to return it from. Refusing here would leave the subscriber charged
    // with nothing to show for it and no automated remedy — strictly the worst
    // outcome available. So record the subscription they paid for and shout, so a
    // human can untangle the identity clash. The route re-checks immediately
    // before the pull, which is what keeps this window to seconds.
    if (platformSettled) {
      console.error(
        `[checkout/complete] IDENTITY CLASH after settlement — wallet ${walletAddress.toLowerCase()} ` +
          `conflicts with ${conflict.subscriptionId} at merchant ${session.merchantId}, but ${tier.amount} ` +
          `has already been paid to the merchant and cannot be recalled. Recording the subscription; ` +
          `needs manual review.`
      );
    } else {
    try {
      await cancelOnChain(onChainSubId!);
    } catch (e) {
      // The subscription is left uncancelled on-chain with the escrow still in it.
      // Nothing is recorded here, so no renewal can ever charge it, but the funds
      // need a manual sweep — log loudly enough to find them.
      console.error(
        `[checkout/complete] wallet ${walletAddress.toLowerCase()} conflicts with ${conflict.subscriptionId} ` +
          `and the escrow refund FAILED — on-chain sub ${onChainSubId} still holds the subscriber's first ` +
          `period: ${describeChainError(e)}`
      );
    }
    throw new CheckoutVerificationError(
      walletConflictMessage(conflict, session.merchant.name),
      409
    );
    }
  }

  const hasTrial = tier.trialDays > 0;
  const days = INTERVAL_DAYS[tier.interval] ?? 30;
  const now = new Date();
  const periodEnd = hasTrial ? addDays(now, tier.trialDays) : addDays(now, days);

  // Mirror the contract's settlement-window escrow: the first payment stays in
  // escrow until the billing engine's settleDuePeriods() pushes it out.
  //
  // A platform-settled activation escrows nothing — the merchant was paid by the
  // mint itself, seconds ago. Zero here is not "unknown", it is the truth, and it
  // keeps this subscription out of settleDuePeriods() entirely.
  const escrowBalance = onChain ? onChain.escrowBalance : 0n;
  const settlementDeadline =
    onChain && onChain.settlementDeadline > 0n
      ? new Date(Number(onChain.settlementDeadline) * 1000)
      : null;

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
      // No contract was involved, so naming one would be a lie a support ticket
      // would later be answered with.
      contractAddress: platformSettled ? null : getManagerAddress(),
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


  const initialPayment = await prisma.payment.create({
    data: {
      paymentId: ids.payment(),
      merchantId: session.merchantId,
      subscriptionId: subscription.id,
      amount: hasTrial ? 0n : tier.amount,
      currency: plan.currency,
      // Escrowed first payments stay "pending" until settlement pushes them out.
      // A platform-settled one was never escrowed — the merchant was paid by the
      // mint, seconds ago — so "pending" would be a lie that never resolves:
      // settleDuePeriods only looks at rows with escrowBalance > 0, so nothing
      // would ever move it.
      status: hasTrial || platformSettled ? "succeeded" : "pending",
      type: "initial",
      isTestMode: session.isTestMode,
      txHash: txHash ?? null,
      blockNumber: blockNumber ? BigInt(blockNumber) : null,
      chain: paidFromChain,
    },
  });

  // The subscriber's receipt, sent now rather than when the escrow settles a day
  // later — they have paid, and that is when a receipt is expected. Zero-value
  // trial starts are filtered inside the sender.
  //
  // AWAITED, unlike the billing-loop call sites. This runs inside a request
  // handler, and a floating promise here is only as durable as the process: a
  // dev-server reload or a deploy between the response and the provider call
  // drops the receipt with nothing to show for it. sendPaymentReceipt catches
  // its own errors and resolves either way, so awaiting cannot fail checkout —
  // it only guarantees the attempt actually happens.
  await sendPaymentReceipt(initialPayment.id);

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: { status: "complete", subscriptionId: subscription.subscriptionId },
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
    chain: paidFromChain,
    // Where it settled, which is Arc regardless of where it was paid from.
    settlement_chain: "arc",
    current_period_end: periodEnd.toISOString(),
    trial_end: subscription.trialEnd?.toISOString() ?? null,
    settlement_deadline: settlementDeadline?.toISOString() ?? null,
  };

  await Promise.all([
    fireWebhook(session.merchantId, session.externalRef, session.merchant.merchantId,
      "checkout.session.completed", eventData),
    fireWebhook(session.merchantId, session.externalRef, session.merchant.merchantId,
      "subscription.created", eventData),
    // The money is already in the merchant's wallet, so the event that says so
    // belongs here. On the escrowed path settleDuePeriods fires it a day later;
    // this path never reaches settleDuePeriods, and without this the merchant
    // would be paid and never told.
    ...(platformSettled && !hasTrial
      ? [
          fireWebhook(session.merchantId, session.externalRef, session.merchant.merchantId,
            "payment.succeeded", {
              subscription_id: subscription.subscriptionId,
              plan_id: plan.planId,
              amount: Number(tier.amount),
              merchant_share: Number(tier.amount - (tier.amount * platformFeeBps()) / 10_000n),
              platform_fee: Number((tier.amount * platformFeeBps()) / 10_000n),
              currency: plan.currency,
              type: "initial",
              tx_hash: txHash ?? null,
              chain: "arc",
              source_chain: paidFromChain,
            }),
        ]
      : []),
  ]);

  const redirectUrl = session.successUrl.includes("{SESSION_ID}")
    ? session.successUrl.replace("{SESSION_ID}", session.sessionId)
    : session.successUrl;

  return { subscription, redirectUrl };
}
