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

/// Whether this grant's period has already been redeemed.
///
/// ERC20PeriodTransferEnforcer allows one transfer per periodDuration, so a second
/// redeem inside the same window reverts on chain. Checking the stored
/// lastRedeemedAt first turns that revert into a cheap 409 instead of a wasted gas
/// bill — but it is advisory only: the enforcer remains the real guard, and a row
/// that is stale in either direction costs correctness nothing.
export function periodConsumed(
  grant: { lastRedeemedAt: Date | null; periodDuration: number },
  now: Date = new Date()
): boolean {
  if (!grant.lastRedeemedAt) return false;
  return now.getTime() - grant.lastRedeemedAt.getTime() < grant.periodDuration * 1000;
}
