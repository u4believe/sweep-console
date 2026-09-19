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
    findMany(args: {
      where: Prisma.SubscriptionWhereInput;
      select: { id: true };
    }): Promise<{ id: string }[]>;
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
  // A raise is permitted. It used to be refused outright, on the grounds that a
  // subscriber's signed cap could not cover it — which was true, and is now
  // handled rather than forbidden: a subscriber whose grant is too small is
  // asked to re-authorize instead of being charged, and is never dunned for it.
  // The "never above the original" ceiling went with that rule; keeping it would
  // have meant storing an original price forever to enforce a limit that only
  // decided WHO had to re-sign.
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

/**
 * Who a price change reaches.
 *
 * - "new"      the listing changes; everyone already subscribed keeps what they
 *              pay now. Grandfathering, and the only scope that never needs a
 *              subscriber to re-authorize.
 * - "existing" the listing is untouched; current subscribers move to the new
 *              price. A loyalty discount without changing the shopfront.
 * - "everyone" both.
 */
export type PriceScope = "new" | "existing" | "everyone";

export interface PriceChangeResult {
  /** Whether the plan's or tier's advertised price was rewritten. */
  listedChanged: boolean;
  /** Live subscriptions moved onto the new price. */
  repriced: number;
  /** Live subscriptions pinned to the old price so a listing change misses them. */
  grandfathered: number;
  /**
   * WHO was moved, by id.
   *
   * Returned rather than left for the caller to work out, because the obvious
   * way to work it out is wrong: looking up subscriptions whose amount equals
   * the new price re-derives the audience from a value that is not an identity.
   * Two subscribers on one plan can sit at different prices after earlier scoped
   * changes, and an inheriting subscriber stores no amount at all — so that
   * lookup silently finds nobody and the price-change emails never go out. This
   * list is the set actually written, and cannot drift from it.
   */
  repricedIds: string[];
}

/**
 * Applies a price change under one scope.
 *
 * The subtlety is the default tier. A subscription on it stores no amount of its
 * own — Subscription.amount is null and the billing engine falls back to
 * plan.amount — so it INHERITS whatever the plan lists. That inheritance is what
 * makes "everyone" free (nothing to write) and what makes "new" require a write:
 * to grandfather an inheriting subscriber you have to pin them to the old price
 * first, or the listing change sweeps them up. Miss that and "applies to new
 * subscribers only" silently reprices everybody.
 *
 * A named tier is the reverse: its subscribers always carry an explicit
 * snapshot, so they are grandfathered by default and only "existing"/"everyone"
 * writes to them.
 */
export async function applyPriceChange(
  tx: SubscriptionRepricer,
  opts: {
    planDbId: string;
    /** Null for the plan's own terms (the default tier at checkout). */
    isDefaultTier: boolean;
    oldAmount: bigint;
    interval: string;
    newAmount: bigint;
    scope: PriceScope;
  }
): Promise<PriceChangeResult> {
  const { planDbId, isDefaultTier, oldAmount, interval, newAmount, scope } = opts;

  // Which live subscriptions are on these terms. For the default tier an
  // inheriting subscriber (null amount, or null interval) counts, which is
  // exactly the set a listing change would otherwise move.
  const where = isDefaultTier
    ? {
        planId: planDbId,
        status: { in: LIVE },
        OR: [{ amount: null }, { amount: oldAmount }],
        AND: [{ OR: [{ interval: null }, { interval }] }],
      }
    : { planId: planDbId, status: { in: LIVE }, amount: oldAmount, interval };

  let repriced = 0;
  let grandfathered = 0;
  let repricedIds: string[] = [];

  if (scope === "new") {
    // Only inheriting subscribers need pinning; an explicit snapshot already
    // equals oldAmount and rewriting it would be a no-op.
    if (isDefaultTier) {
      const { count } = await tx.subscription.updateMany({
        where: { planId: planDbId, status: { in: LIVE }, amount: null },
        data: { amount: oldAmount },
      });
      grandfathered = count;
    }
  } else {
    // Read the ids BEFORE the write: afterwards these rows carry the new price
    // and are indistinguishable from subscribers who were already on it.
    repricedIds = (await tx.subscription.findMany({ where, select: { id: true } })).map((r) => r.id);
    const { count } = await tx.subscription.updateMany({ where, data: { amount: newAmount } });
    repriced = count;
  }

  return { listedChanged: scope !== "existing", repriced, grandfathered, repricedIds };
}
