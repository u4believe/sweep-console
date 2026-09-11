// How a mandate finds its grants, in one place.
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
