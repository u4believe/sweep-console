// Single-active-subscription kill switch.
//
// Shared by the cancel API (POST /v1/subscriptions/:id/cancel) and the upgrade
// auto-replace path (checkout completion). This is the actual double-bill guard:
// it neutralises EVERY authorization a subscription holds so the renewal pass can
// never charge it again.
//
// Note on on-chain cleanup: there is nothing of ours to cancel on-chain. The
// lingering ERC-7715 delegation can only be disabled by the delegator (the user's
// own wallet) — `disableDelegation` is `onlyDeleGator` — so we cannot revoke it
// for them. We don't need to: we are the sole named delegate, and marking the
// RenewalDelegation "revoked" stops us redeeming it. The on-chain delegation then
// sits inert until its expiry.

import { prisma } from "../prisma";
import { fireWebhook } from "../webhooks/delivery";
import type { Plan, Subscription } from "@prisma/client";

type SubWithPlan = Subscription & { plan: Plan };

export interface RevokeResult {
  revokedDelegations: number;
}

/**
 * Cancels a subscription and revokes all of its renewal authority:
 *   1. flips the Subscription to "cancelled".
 *   2. marks every active RenewalDelegation "revoked" — the renewal engine
 *      filters on status, so this alone prevents any future charge.
 *   3. fires subscription.cancelled.
 *
 * Cancelling moves no money. It used to: the contract returned the unsettled
 * escrow in the same transaction, which is why this once reported a refund and
 * a tx hash. Nothing is held back any more, so a cancel is purely the removal of
 * future authority — there is no refund to make and nothing on-chain to fail.
 */
export async function revokeSubscription(
  sub: SubWithPlan,
  merchantPublicId: string,
  opts: { reason: string }
): Promise<RevokeResult> {
  const [, delg] = await prisma.$transaction([
    prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelReason: opts.reason,
        // Vestigial mirrors of the retired contract; kept tidy until the columns go.
        escrowBalance: 0n,
        settlementDeadline: null,
      },
    }),
    prisma.renewalDelegation.updateMany({
      where: { subscriptionId: sub.id, status: "active" },
      data: { status: "revoked" },
    }),
    // No refund Payment row: this used to record the escrow the contract handed
    // back, and with escrow gone it only ever wrote a 0-value "refund" that never
    // happened. A refund row is now written when money actually moves, or not at
    // all.
  ]);

  await fireWebhook(sub.merchantId, sub.externalRef, merchantPublicId, "subscription.cancelled", {
    subscription_id: sub.subscriptionId,
    plan_id: sub.plan.planId,
    cancel_reason: opts.reason,
    wallet_address: sub.walletAddress,
    cancelled_at: new Date().toISOString(),
    revoked_delegations: delg.count,
  });

  return { revokedDelegations: delg.count };
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
      // The customer is the anchor: only subscriptions belonging to the identity
      // that just proved itself may be retired. Matching on subscriberEmail alone
      // would let a checkout reach a subscription owned by a DIFFERENT customer
      // row that carries the same address, so the email branch is restricted to
      // legacy subs with no customer of their own (pre-Customer, Passport-era).
      ...(customerDbId
        ? { OR: [{ customerId: customerDbId }, { customerId: null, subscriberEmail }] }
        : { customerId: null, subscriberEmail }),
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
