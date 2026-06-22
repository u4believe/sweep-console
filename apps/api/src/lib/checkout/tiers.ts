// Tier resolution for checkout/billing.
//
// A plan's own amount/interval/trialDays is the DEFAULT tier; `PlanTier` rows are
// additional options. Every charge path resolves the EFFECTIVE terms from the
// checkout session's chosen tier (or the default when none was chosen), so the
// amount/interval flow uniformly through the permit, on-chain subscribe, the
// renewal grant, escrow, and the engine.

import { prisma } from "../prisma";

export interface ResolvedTier {
  amount: bigint;
  interval: string;
  trialDays: number;
  settlementWindowHours: number | null;
  tierId: string | null;
  tierName: string | null;
}

interface PlanTerms {
  id: string;
  amount: bigint;
  interval: string;
  trialDays: number;
  settlementWindowHours: number | null;
}

/// Effective terms for a checkout: the chosen `PlanTier` (validated to belong to
/// the plan and be active), or the plan's default tier when `tierId` is null.
export async function resolveTier(plan: PlanTerms, tierId: string | null | undefined): Promise<ResolvedTier> {
  if (!tierId) {
    return {
      amount: plan.amount,
      interval: plan.interval,
      trialDays: plan.trialDays,
      settlementWindowHours: plan.settlementWindowHours,
      tierId: null,
      tierName: null,
    };
  }
  const tier = await prisma.planTier.findFirst({
    where: { id: tierId, planId: plan.id, archived: false },
  });
  if (!tier) throw new Error("Selected tier is not available for this plan");
  return {
    amount: tier.amount,
    interval: tier.interval,
    trialDays: tier.trialDays,
    settlementWindowHours: plan.settlementWindowHours, // escrow window is plan-level
    tierId: tier.id,
    tierName: tier.name,
  };
}
