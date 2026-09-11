// Plan lifecycle — closing a plan self-enforces the trust guarantee.
//
// Deleting a plan stops billing immediately (the plan is archived; every billing
// pass skips cancelled/archived-plan subs) and, for each active subscriber:
//   - stops billing in the database (there is no contract to cancel and no
//     escrow to return — payments settle straight to the merchant)
//     to the subscriber in the same tx (owner-callable; no contract change),
//   - flips the DB status to "cancelled" so the relayer never touches it again,
//   - fires subscription.cancelled, and
//   - sends ONE honest "we stopped charging, your funds are safe" email.
// Best-effort per subscriber: a failed on-chain cancel still flips the DB so a
// closed plan can never be billed.

import { formatUnits } from "viem";
import { prisma } from "./prisma";
import { sendEmail, planClosedEmailHtml } from "./email";
import { fireWebhook } from "./webhooks/delivery";

export interface ClosingSub {
  id: string;
  subscriptionId: string;
  merchantId: string;
  externalRef: string;
  onChainSubId: string | null;
  subscriberEmail: string | null;
}

export interface ClosingPlan {
  name: string;
  currency: string;
  merchantName: string;
  merchantPublicId: string;
}

/// The non-terminal subscriptions of a plan, with just the fields needed to close
/// them. Use the returned array for both the immediate count and the detached run.
export function findSubsToClose(planDbId: string) {
  return prisma.subscription.findMany({
    where: { planId: planDbId, status: { in: ["active", "trialing", "past_due"] } },
    select: {
      id: true,
      subscriptionId: true,
      merchantId: true,
      externalRef: true,
      onChainSubId: true,
      subscriberEmail: true,
    },
  });
}

/// Stop + refund every subscriber of a deleted plan, then notify once. Detached:
/// callers fire-and-forget this after archiving the plan and responding.
export async function closePlanSubscriptions(plan: ClosingPlan, subs: ClosingSub[]): Promise<void> {
  for (const sub of subs) {
    // Nothing to cancel or refund on-chain: no contract holds these subscriptions
    // and no escrow exists, so stopping the billing IS the whole cancellation.
    const refundTx: string | null = null;
    const refundAmount: string | null = null;

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "cancelled", cancelledAt: new Date(), cancelReason: "plan_deleted" },
    });

    await fireWebhook(sub.merchantId, sub.externalRef, plan.merchantPublicId, "subscription.cancelled", {
      subscription_id: sub.subscriptionId,
      reason: "plan_deleted",
      refunded_escrow: refundAmount,
      tx_hash: refundTx,
    }).catch((e) => console.error(`[plan-lifecycle] webhook failed for ${sub.subscriptionId}:`, e));

    if (sub.subscriberEmail) {
      await sendEmail({
        to: sub.subscriberEmail,
        subject: `Your ${plan.name} subscription has ended`,
        html: planClosedEmailHtml({
          merchantName: plan.merchantName,
          planName: plan.name,
          subscriptionId: sub.subscriptionId,
          refundTx,
          refundAmount,
        }),
        text:
          `${plan.name} was closed by ${plan.merchantName}. Billing has stopped and will never resume. ` +
          `${refundAmount ? `We returned ${refundAmount} held in escrow to your wallet (tx ${refundTx}). ` : ""}` +
          `Your renewal permission is now dormant — you can revoke it in your wallet anytime, but you don't need to. Your funds are safe.`,
      }).catch((e) => console.error(`[plan-lifecycle] email failed for ${sub.subscriptionId}:`, e));
    }
  }
  console.log(`[plan-lifecycle] closed ${subs.length} subscription(s) for plan ${plan.name}`);
}
