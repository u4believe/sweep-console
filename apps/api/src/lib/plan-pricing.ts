// Lowering the price of a plan or tier.
//
// A price may only ever go DOWN. That is not a product preference, it is what
// keeps the feature safe: every subscriber signed an ERC-7715 grant capped at
// the price they saw, and their own wallet refuses anything above it. A cut is
// always collectable — the cap covers it with room to spare — while a rise would
// be refused on-chain for everyone who signed below it, sending paying customers
// to past_due for something the creator did.
//
// Monotonic means the ceiling needs no column of its own: the current stored
// price IS the ceiling, because you can only ever descend from wherever you are.
// The interval is never editable at all — it is baked into the signed grant's
// period schedule, so changing it would desynchronise every subscriber's enforcer
// window from the billing clock.

import type { Prisma } from "@prisma/client";

/// Structural rather than Prisma.TransactionClient: the client is $extends-ed,
/// so a transaction handle is not assignable to the generated type. This needs
/// exactly one updateMany.
interface SubscriptionRepricer {
  subscription: {
    updateMany(args: {
      where: Prisma.SubscriptionWhereInput;
      data: { amount: bigint };
    }): Promise<{ count: number }>;
  };
}

/// Statuses whose next renewal should honour a cut. Cancelled subscriptions are
/// left alone: they will not be charged again, and rewriting settled terms would
/// misrepresent what they were sold.
const LIVE = ["active", "trialing", "past_due"];

/**
 * Why this price change is refused, or null when it may proceed.
 *
 * Equal is refused rather than treated as a no-op, so a creator who thinks they
 * changed something is told they did not.
 */
export function refusePriceChange(current: bigint, next: bigint): string | null {
  if (next <= 0n) return "A price must be greater than zero.";
  if (next === current) {
    return `That is already the price (${fmt(current)} USDC).`;
  }
  if (next > current) {
    return (
      `A price can only be lowered, and this would raise it from ${fmt(current)} to ${fmt(next)} USDC. ` +
      `Every subscriber authorized their wallet for at most ${fmt(current)} per period, so a higher ` +
      `charge would be refused by their wallet and their subscription would fall past due. ` +
      `Add a new tier to sell at a higher price.`
    );
  }
  return null;
}

function fmt(v: bigint): string {
  return (Number(v) / 1_000_000).toFixed(2);
}

/**
 * Carries a cut to the subscribers already on those terms, returning how many
 * were updated.
 *
 * Only NAMED tiers need this. A default-tier subscription stores no amount — it
 * resolves plan.amount at renewal — so cutting the plan's own price reaches those
 * subscribers with no write at all.
 *
 * Matching is on the exact old terms rather than "anything dearer than the new
 * price", which would drag an unrelated tier's subscribers down with it. Two
 * tiers sharing an amount and interval are economically the same tier, so
 * catching both is right.
 */
export async function propagateTierPriceCut(
  tx: SubscriptionRepricer,
  planDbId: string,
  oldAmount: bigint,
  interval: string,
  newAmount: bigint
): Promise<number> {
  const { count } = await tx.subscription.updateMany({
    where: {
      planId: planDbId,
      status: { in: LIVE },
      amount: oldAmount,
      interval,
    },
    data: { amount: newAmount },
  });
  return count;
}
