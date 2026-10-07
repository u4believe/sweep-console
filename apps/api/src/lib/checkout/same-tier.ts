// Is this subscriber already on the tier they are about to buy?
//
// Not a wallet question — wallet-guard.ts answers that one, and deliberately lets
// the same customer pay again because that is how an upgrade works. This is the
// narrower case it leaves open: the same person, the same merchant, the SAME
// tier, paying a second time. Nothing about that is an upgrade. They already have
// it, and completing the checkout would take another initial charge, retire the
// subscription they are paying to keep, and create an identical one.
//
// Matched on the tier reference rather than on price. Two tiers may cost the
// same, and a repriced tier stops matching its own subscribers — so amount and
// interval cannot answer "which tier is this".
import { prisma } from "../prisma";
import { normalizeEmail } from "./identity";

/// Statuses that still bill, and so still represent "you already have this".
const LIVE = ["active", "trialing", "past_due"];

export interface SameTierSubscription {
  subscriptionId: string;
  tierName: string | null;
}

/**
 * The subscriber's existing subscription on this exact tier, if there is one.
 *
 * `tierId` is null for the plan's default tier, which has no PlanTier row — in
 * that case a prior subscription on the default tier is the match, identified
 * the same way: by the absence of a reference, not by its price.
 *
 * Returns null for subscriptions predating the planTierId column, since their
 * tier genuinely is not known. Guessing from price is what this exists to avoid,
 * and a false "you already have this" blocks a sale.
 */
export async function findSameTierSubscription(params: {
  merchantId: string;
  planId: string;
  tierId: string | null;
  customerDbId?: string | null;
  email?: string | null;
}): Promise<SameTierSubscription | null> {
  const { merchantId, planId, tierId, customerDbId } = params;
  const email = params.email ? normalizeEmail(params.email) : null;
  if (!customerDbId && !email) return null;

  const existing = await prisma.subscription.findFirst({
    where: {
      merchantId,
      planId,
      status: { in: LIVE },
      // The same identity rule wallet-guard uses: the customer row is the anchor,
      // and the email branch is restricted to legacy subscriptions with no
      // customer of their own.
      ...(customerDbId
        ? { OR: [{ customerId: customerDbId }, ...(email ? [{ customerId: null, subscriberEmail: email }] : [])] }
        : { customerId: null, subscriberEmail: email! }),
      // Null means the plan's default tier — a real value, not "unknown". A row
      // written before this column existed is excluded by requiring a match on
      // the tier the checkout actually resolved.
      planTierId: tierId,
    },
    select: { subscriptionId: true, planTier: { select: { name: true } } },
  });

  if (!existing) return null;
  return { subscriptionId: existing.subscriptionId, tierName: existing.planTier?.name ?? null };
}
