// One-charge-per-cycle lock shared by both renewal paths.
//
// A subscriber may hold liquidity (and have granted mandates) on several chains,
// and two renewal passes (Arc allowance + cross-chain CCTP) run on the same cron
// tick. Before charging a subscription's due period, each path must claim
// (subscriptionId, periodKey); the unique constraint makes that atomic, so exactly
// one path/chain charges a given period — no double-charge across chains or passes.

import { prisma } from "../lib/prisma";

/// The due period being charged, keyed by its end boundary (stable across paths
/// until the renewal advances currentPeriodEnd to the next period).
export function periodKeyFor(sub: { currentPeriodEnd: Date }): string {
  return String(sub.currentPeriodEnd.getTime());
}

/// Atomically claim the right to charge this period. Returns false when another
/// path/run already holds it — the caller MUST skip (don't charge).
export async function claimPeriod(subscriptionId: string, periodKey: string): Promise<boolean> {
  try {
    await prisma.renewalClaim.create({ data: { subscriptionId, periodKey } });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return false; // unique violation = already claimed
    throw e;
  }
}

/// Release a claim so a later retry of the SAME period can re-acquire it. Call ONLY
/// when the charge moved no funds (a fresh attempt is then safe). Once funds have
/// moved or the period has advanced, leave the claim in place.
export async function releaseClaim(subscriptionId: string, periodKey: string): Promise<void> {
  await prisma.renewalClaim.deleteMany({ where: { subscriptionId, periodKey } });
}
