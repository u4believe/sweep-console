/** Shared plan shapes and money helpers for the portal's plan screens. */

export interface Tier {
  id: string;
  name: string;
  amount: number;
  interval: string;
  trial_days: number;
  features?: string[] | null;
}

export interface Plan {
  id: string;
  name: string;
  description: string | null;
  amount: number;
  currency: string;
  interval: string;
  trial_days: number;
  /** Active + trialing subscriptions. Cancelled and past-due are NOT counted. */
  subscribers: number;
  /**
   * Monthly run-rate for this plan, in USDC micro-units, summed from each live
   * subscription's own amount and interval. Server-computed: the browser sees
   * only the plan's default price, which is wrong for any plan with tiers.
   */
  mrr: number;
  default_tier_name?: string | null;
  /** Feature list shown on the default tier's checkout card. */
  default_features?: string[] | null;
  /** Tier id badged "Recommended" at checkout, "default" for the plan's own terms. */
  recommended_tier_id?: string | null;
  tiers?: Tier[];
}

export interface PaymentLink {
  id: string;
  url: string;
  plan_id: string;
}

/**
 * Monthly-equivalent value of one billing cycle, in USDC micro-units.
 *
 * Weeks use 365/12/7 ≈ 4.348 weeks per month rather than a flat 4, which would
 * understate weekly plans by about 8%.
 *
 * NOT for MRR — use the server's `Plan.mrr`, which prices each subscription at
 * what it was actually sold for. This is for showing what a single price would
 * come to per month.
 */
export function monthlyEquivalent(amount: number, interval: string): number {
  switch (interval) {
    case "daily": return amount * (365 / 12);
    case "weekly": return amount * (365 / 12 / 7);
    case "yearly": return amount / 12;
    case "monthly":
    default: return amount;
  }
}

/**
 * Singular noun for an interval, for "per month" style copy. A naive
 * interval.replace(/ly$/, "") turns "daily" into "dai".
 */
export const INTERVAL_NOUNS: Record<string, string> = {
  daily: "day", weekly: "week", monthly: "month", yearly: "year",
};

/** Reads a tier's features regardless of whether the API stored them loosely. */
export function featureList(features: unknown): string[] {
  if (Array.isArray(features)) return features.filter((f): f is string => typeof f === "string");
  return [];
}
