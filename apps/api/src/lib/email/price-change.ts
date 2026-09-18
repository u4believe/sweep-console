// Telling subscribers a price changed.
//
// This is the half of repricing that makes the feature legitimate. A standing
// wallet authorization is a lot of trust, and the creator can now change what it
// collects — so the change has to reach the people it affects, in their inbox,
// naming both numbers and who made it.
//
// Each notice is tailored, because the two situations need different words.
// A subscriber whose signed cap still covers the new price needs to know and do
// nothing. A subscriber whose cap is too small has a subscription that will
// collect nothing until they act — not a payment failure, an authorization
// shortfall — and telling them that generically would leave them to discover it
// as money that quietly stopped moving.
//
// Never throws, and never blocks the creator's request: the price is already
// changed by the time this runs.

import { prisma } from "../prisma";
import { sendEmail, priceChangeEmailHtml } from "../email";

const LIVE = ["active", "trialing", "past_due"];
const usdc = (v: bigint) => (Number(v) / 1_000_000).toFixed(2);

export interface PriceChangeNotice {
  planDbId: string;
  /** Null for the plan's own terms; a tier name otherwise, for the subject line. */
  tierName: string | null;
  oldAmount: bigint;
  newAmount: bigint;
  interval: string;
  /** Only subscriptions now paying this are notified. */
  appliesToExisting: boolean;
}

/**
 * Emails the affected subscribers, returning how many were told.
 *
 * Nobody is emailed when the change reaches only NEW subscribers: their price
 * did not move, and a notice about someone else's price is noise that teaches
 * people to ignore the next one.
 */
export async function sendPriceChangeNotices(n: PriceChangeNotice): Promise<number> {
  if (!n.appliesToExisting) {
    console.log(`[price-change] plan ${n.planDbId}: new subscribers only — nobody notified`);
    return 0;
  }

  try {
    const subs = await prisma.subscription.findMany({
      where: { planId: n.planDbId, status: { in: LIVE }, amount: n.newAmount },
      select: {
        subscriptionId: true,
        subscriberEmail: true,
        currentPeriodEnd: true,
        plan: { select: { name: true, merchant: { select: { name: true } } } },
        customer: { select: { email: true } },
        renewalDelegations: {
          where: { status: "active" },
          select: { periodAmount: true },
        },
      },
    });

    let sent = 0;
    for (const sub of subs) {
      const to = sub.customer?.email ?? sub.subscriberEmail;
      if (!to) continue;

      // Covered if ANY live grant can carry the new price. One chain is enough
      // to collect, so requiring all of them would cry wolf at someone who is
      // perfectly payable.
      const bestCap = sub.renewalDelegations.reduce(
        (max, g) => (g.periodAmount > max ? g.periodAmount : max),
        0n
      );
      const needsReauthorization = bestCap < n.newAmount;

      await sendEmail({
        to,
        subject: needsReauthorization
          ? `Action needed — ${sub.plan.merchant.name} changed the price of ${n.tierName ?? sub.plan.name}`
          : `${sub.plan.merchant.name} changed the price of ${n.tierName ?? sub.plan.name}`,
        html: priceChangeEmailHtml({
          merchantName: sub.plan.merchant.name,
          planName: n.tierName ?? sub.plan.name,
          oldAmount: usdc(n.oldAmount),
          newAmount: usdc(n.newAmount),
          currency: "USDC",
          interval: n.interval,
          effectiveFrom: sub.currentPeriodEnd,
          needsReauthorization,
        }),
        text:
          `${sub.plan.merchant.name} changed the price of ${n.tierName ?? sub.plan.name} from ` +
          `${usdc(n.oldAmount)} to ${usdc(n.newAmount)} USDC per ${n.interval}. ` +
          (needsReauthorization
            ? `Your wallet authorized up to ${usdc(n.oldAmount)}, so nothing can be collected until you ` +
              `approve the new amount. Update it at ${process.env.NEXT_PUBLIC_APP_URL ?? ""}/manage, or cancel there.`
            : `Your existing authorization covers it — nothing to do.`),
      }).catch((e) => console.warn(`[price-change] ${sub.subscriptionId}: ${(e as Error).message}`));
      sent++;
      if (needsReauthorization) {
        console.log(`[price-change] ${sub.subscriptionId} needs re-authorization (cap ${bestCap} < ${n.newAmount})`);
      }
    }

    console.log(`[price-change] plan ${n.planDbId}: notified ${sent} of ${subs.length} affected subscription(s)`);
    return sent;
  } catch (e) {
    // The price is already changed; a mail failure must not look like a failed edit.
    console.warn("[price-change] could not send notices:", (e as Error).message);
    return 0;
  }
}
