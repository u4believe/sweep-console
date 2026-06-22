// Single-active-subscription kill switch.
//
// Shared by the cancel API (POST /v1/subscriptions/:id/cancel) and the upgrade
// auto-replace path (checkout completion). This is the actual double-bill guard:
// it neutralises EVERY authorization a subscription holds so neither renewal
// engine — the Arc allowance pass nor the cross-chain CCTP/7715 pass — can ever
// charge it again.
//
// Note on on-chain cleanup: the contract's cancelSubscription() is owner-callable
// (the platform IS owner) and is fully gasless for the subscriber. The lingering
// ERC-7715 delegation can only be disabled on-chain by the delegator (the user's
// own wallet) — `disableDelegation` is `onlyDeleGator` — so we cannot revoke it
// for them. We don't need to: we are the sole named delegate, and marking the
// RenewalDelegation "revoked" stops us redeeming it. The on-chain delegation then
// sits inert until its expiry.

import { prisma } from "../prisma";
import { ids } from "../ids";
import { fireWebhook } from "../webhooks/delivery";
import { cancelOnChain } from "../chain/subscription";
import type { Plan, Subscription } from "@prisma/client";

type SubWithPlan = Subscription & { plan: Plan };

export interface RevokeResult {
  refundedEscrow: bigint;
  cancelTxHash: string | null;
  cancelBlockNumber: bigint | null;
  /// Set when the on-chain cancel reverted but the DB revoke still proceeded.
  onChainError: unknown | null;
  revokedDelegations: number;
}

/**
 * Cancels a subscription and revokes all of its renewal authority:
 *   1. cancelSubscription() on-chain (owner-paid) — stops contract renewals and
 *      returns any settlement-window escrow to the subscriber in the same tx.
 *   2. flips the Subscription to "cancelled" and clears its escrow mirror.
 *   3. marks every active RenewalDelegation "revoked" — both renewal engines
 *      filter on status, so this alone prevents any future charge.
 *   4. records the escrow refund and fires subscription.cancelled.
 *
 * The on-chain cancel is best-effort by default: if it reverts, the DB revoke in
 * steps 2–3 still guarantees no future charge, so the upgrade path must not be
 * blocked by a transient chain failure. The explicit cancel API passes
 * `throwOnChainError` so a merchant-initiated cancel surfaces a 502 instead.
 */
export async function revokeSubscription(
  sub: SubWithPlan,
  merchantPublicId: string,
  opts: { reason: string; throwOnChainError?: boolean }
): Promise<RevokeResult> {
  let refundedEscrow = 0n;
  let cancelTxHash: string | null = null;
  let cancelBlockNumber: bigint | null = null;
  let onChainError: unknown | null = null;

  if (sub.onChainSubId) {
    try {
      const result = await cancelOnChain(sub.onChainSubId);
      refundedEscrow = result.refundedEscrow;
      cancelTxHash = result.txHash;
      cancelBlockNumber = result.blockNumber;
    } catch (e) {
      if (opts.throwOnChainError) throw e;
      onChainError = e;
      console.error(
        `[revoke] on-chain cancel failed for ${sub.subscriptionId} (continuing with DB revoke):`,
        e
      );
    }
  }

  const [, delg] = await prisma.$transaction([
    prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelReason: opts.reason,
        escrowBalance: 0n,
        settlementDeadline: null,
      },
    }),
    prisma.renewalDelegation.updateMany({
      where: { subscriptionId: sub.id, status: "active" },
      data: { status: "revoked" },
    }),
    prisma.payment.create({
      data: {
        paymentId: ids.payment(),
        merchantId: sub.merchantId,
        subscriptionId: sub.id,
        amount: refundedEscrow,
        currency: sub.plan.currency,
        status: "succeeded",
        type: "refund",
        isTestMode: sub.isTestMode,
        txHash: cancelTxHash,
        blockNumber: cancelBlockNumber,
        chain: "arc",
      },
    }),
  ]);

  await fireWebhook(sub.merchantId, sub.externalRef, merchantPublicId, "subscription.cancelled", {
    subscription_id: sub.subscriptionId,
    plan_id: sub.plan.planId,
    cancel_reason: opts.reason,
    wallet_address: sub.walletAddress,
    cancelled_at: new Date().toISOString(),
    refunded_escrow: Number(refundedEscrow),
    revoked_delegations: delg.count,
    tx_hash: cancelTxHash,
    block_number: cancelBlockNumber !== null ? Number(cancelBlockNumber) : null,
  });

  return {
    refundedEscrow,
    cancelTxHash,
    cancelBlockNumber,
    onChainError,
    revokedDelegations: delg.count,
  };
}

/**
 * Enforces ONE active subscription per customer per merchant (email-anchored
 * identity). Called at checkout completion: retires every other active sub for
 * this customer so an upgrade (e.g. 10 USDC/mo → 100 USDC/yr) can never leave the
 * old plan billing alongside the new one. Returns how many were retired.
 *
 * Each retire is isolated: a failure to retire one prior sub must never fail the
 * new activation (the subscriber has already paid on-chain). The renewal crons
 * also filter on status, so a logged failure here is recovered on the next pass.
 */
export async function retirePriorActiveSubscriptions(params: {
  merchantId: string;
  merchantPublicId: string;
  customerDbId?: string | null;
  subscriberEmail: string;
  exceptSubscriptionId: string;
}): Promise<number> {
  const { merchantId, merchantPublicId, customerDbId, subscriberEmail, exceptSubscriptionId } = params;

  const prior = await prisma.subscription.findMany({
    where: {
      merchantId,
      id: { not: exceptSubscriptionId },
      status: { in: ["active", "trialing", "past_due"] },
      // Email is the identity anchor; also match the stable customerId when set.
      ...(customerDbId ? { OR: [{ customerId: customerDbId }, { subscriberEmail }] } : { subscriberEmail }),
    },
    include: { plan: true },
  });

  let retired = 0;
  for (const old of prior) {
    try {
      await revokeSubscription(old, merchantPublicId, { reason: "replaced_by_upgrade" });
      retired++;
    } catch (e) {
      console.error(`[upgrade] failed to retire prior sub ${old.subscriptionId}:`, e);
    }
  }
  return retired;
}
