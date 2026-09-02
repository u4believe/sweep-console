// Recurring-allowance sizing.
//
// A wallet holds exactly ONE USDC allowance for the SubscriptionManager, and the
// manager is platform-global (getManagerAddress() takes no merchant). Every
// subscription that wallet pays for — at ANY merchant — draws down that same
// pool.
//
// Sizing the grant from the new plan alone (amount × ALLOWANCE_PERIODS) therefore
// under-funds any wallet that already subscribes elsewhere, because both ways of
// granting it SET the allowance rather than add to it: ERC-20 approve overwrites,
// and so does an EIP-2612 permit. The second checkout would silently reset the
// first subscription's runway, and the two would then race to drain what is left
// — whichever renewal cron ran second reverted with "transfer amount exceeds
// allowance" and the subscriber went past_due at a merchant they never touched.
//
// The floor below is additive across subscriptions instead: the sum of every live
// subscription's per-period amount (the new one included) × ALLOWANCE_PERIODS, so
// each keeps a full term of headroom. It is a pure function of persisted state,
// so recomputing it on a retry yields the same number — callers skip the grant
// when the on-chain allowance already meets it, which keeps retries idempotent.

import { prisma } from "../prisma";

/// A subscriber grants a year of renewals up front — 12 periods of the plan.
export const ALLOWANCE_PERIODS = 12n;

/// Subscriptions that can still be charged, and so still need allowance behind them.
const CHARGEABLE = ["active", "trialing", "past_due"];

/// The USDC allowance this wallet must hold for the manager to cover every
/// subscription it pays for: the ones it already has, plus `newAmount` for the one
/// being created. Pass 0n to size the floor for the wallet's existing load alone.
export async function requiredAllowance(walletAddress: string, newAmount: bigint): Promise<bigint> {
  const live = await prisma.subscription.findMany({
    where: { walletAddress: walletAddress.toLowerCase(), status: { in: CHARGEABLE } },
    select: { amount: true, plan: { select: { amount: true } } },
  });
  // amount is null on subs that took the plan's default tier — fall back to it.
  const perPeriod = live.reduce((sum, s) => sum + (s.amount ?? s.plan.amount), newAmount);
  return perPeriod * ALLOWANCE_PERIODS;
}
