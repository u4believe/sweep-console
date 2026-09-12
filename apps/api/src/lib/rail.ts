// How a mandate finds its grants, and what its period ceiling has left.
//
//
// A Mandate's grants are RenewalDelegation rows bound by `sessionId` holding the
// mandate's public id — the same way checkout binds grants to a session before the
// Subscription exists. `mode: "external"` keeps hosted grants out of the set even
// if a checkout session id ever collided, which the prefixes ("cs_" vs "mdt_")
// already prevent.
//
// This is deliberately the ONLY definition. The contract step replaces it with a
// real foreign key once RenewalDelegation.mandateId is freed from its legacy
// public id, and when that happens exactly one function changes.

import type { Prisma } from "@prisma/client";

interface ChargeAggregator {
  charge: {
    aggregate(args: {
      where: Prisma.ChargeWhereInput;
      _sum: { amount: true };
    }): Promise<{ _sum: { amount: bigint | null } }>;
  };
}

export function mandateGrantsWhere(mandateId: string) {
  return { sessionId: mandateId, mode: "external" as const };
}

/// Whether this grant's CURRENT enforcer period has already been redeemed.
///
/// ERC20PeriodTransferEnforcer divides time into FIXED periods anchored at the
/// grant's startDate — [start, start+d), [start+d, start+2d), … — and allows one
/// transfer in each. It is not a sliding window, and that distinction is not
/// academic: an earlier version of this compared `now - lastRedeemedAt` against
/// the duration, which stays "consumed" for a full duration after the redeem
/// rather than until the period boundary. A daily grant redeemed a minute before
/// its boundary would have been reported consumed for nearly another day, and the
/// renewal it blocked would have run 24h late.
///
/// Advisory only. The enforcer is the real guard; this just turns a reverted
/// transaction into free arithmetic, so being stale in either direction costs
/// correctness nothing — only gas, or a delay until the next pass.
export function periodConsumed(
  grant: { lastRedeemedAt: Date | null },
  terms: { startDate: number; periodDuration: number },
  now: Date = new Date()
): boolean {
  if (!grant.lastRedeemedAt) return false;
  if (terms.periodDuration <= 0) return false;
  const periodOf = (unixSeconds: number) =>
    Math.floor((unixSeconds - terms.startDate) / terms.periodDuration);
  const last = Math.floor(grant.lastRedeemedAt.getTime() / 1000);
  // A redeem recorded before the grant's own start date cannot belong to this
  // schedule at all — treat the current period as free rather than guessing.
  if (last < terms.startDate) return false;
  return periodOf(last) === periodOf(Math.floor(now.getTime() / 1000));
}

/// The start of the mandate's CURRENT period.
///
/// Fixed windows anchored at the moment the subscriber authorized — [start,
/// start+d), [start+d, start+2d), … — deliberately the same shape as the
/// enforcer's schedule in periodConsumed above, so "this period" means one thing
/// across the rail rather than two. The anchor is authorizedAt and not createdAt
/// because the ceiling is something the SUBSCRIBER agreed to; the clock should
/// start when they agreed to it, not when the developer drafted the request.
export function mandatePeriodStart(
  mandate: { authorizedAt: Date | null; createdAt: Date; periodDuration: number },
  now: Date = new Date()
): Date {
  const anchor = mandate.authorizedAt ?? mandate.createdAt;
  if (mandate.periodDuration <= 0) return anchor;
  const anchorSeconds = Math.floor(anchor.getTime() / 1000);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (nowSeconds <= anchorSeconds) return anchor;
  const periodIndex = Math.floor((nowSeconds - anchorSeconds) / mandate.periodDuration);
  return new Date((anchorSeconds + periodIndex * mandate.periodDuration) * 1000);
}

/// What this mandate has already committed in the window starting at `since`.
///
/// "Committed", not "collected": a pending charge counts. A charge row is created
/// before its funds move and settles seconds to minutes later, so ignoring
/// pending would let two requests in that gap each believe the whole ceiling was
/// free. A charge that ends up failing releases its reservation by leaving this
/// set, which is why the status filter is a whitelist and not `not: "failed"` —
/// a future status nobody thought about must not silently spend the cap.
///
/// `excludeChargeId` is for a caller re-checking on behalf of a charge row that
/// already exists: without it a charge would count itself and refuse itself.
export async function periodCommitted(
  // Structural rather than Prisma.TransactionClient: the client is $extends-ed,
  // so a transaction handle is not assignable to the plain generated type. All
  // this needs is the one aggregate it calls.
  db: ChargeAggregator,
  mandateDbId: string,
  since: Date,
  excludeChargeId?: string
): Promise<bigint> {
  const agg = await db.charge.aggregate({
    where: {
      mandateId: mandateDbId,
      status: { in: ["pending", "succeeded"] },
      createdAt: { gte: since },
      ...(excludeChargeId ? { id: { not: excludeChargeId } } : {}),
    },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? 0n;
}
