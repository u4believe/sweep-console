/**
 * The platform's cut, in basis points.
 *
 * ONE READER OF PLATFORM_FEE_BPS, because there were five and they did not
 * agree. Four copies of `platformFeeBps()` — in direct-charge, delegated-
 * renewal, cctp-activate and complete — each defaulted to 0, while
 * GET /config advertised a default of 200. The charging paths and the number
 * on the pricing page could differ by two percentage points on any deployment
 * that had not set the variable, and nothing would have reported it: the
 * creator would be shown a fee that was not taken, or taken a fee they were
 * not shown.
 *
 * ZERO IS THE DEFAULT, deliberately, and the advertised value now follows it.
 * A deployment that has not decided its fee should take nothing rather than
 * quietly take 2% — an unconfigured platform skimming a real payment is worse
 * than one that forgets to charge, and the second is obvious within a day
 * while the first is not.
 *
 * Live runs 250. That is a Railway variable, not a default here, so this file
 * does not need editing when it changes — and must not be, or the two drift
 * again in the other direction.
 *
 * WHAT THE RATE HAS TO COVER is in charge-floor.ts, which carries the measured
 * per-chain gas and the margin a given rate leaves at the floor. The two are
 * read together: the fee decides what a payment earns, the floor decides the
 * smallest payment allowed to earn it.
 */

/// Basis points: 250 = 2.5%.
export function platformFeeBps(): bigint {
  const raw = process.env.PLATFORM_FEE_BPS ?? "0";
  const n = Number(raw);
  /**
   * A malformed value takes nothing rather than throwing.
   *
   * The opposite of MIN_CHARGE_USDC, which throws on nonsense — and the
   * difference is which failure is worse. A broken floor silently lets
   * unprofitable plans through, so it must be loud. A broken fee that
   * resolves to zero costs the platform its margin, which shows up in the
   * treasury immediately; a fee that throws instead would refuse payments
   * outright, and a typo in an env var should not stop a creator being paid.
   */
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[fee] PLATFORM_FEE_BPS is not a number: ${JSON.stringify(raw)} — taking 0`);
    return 0n;
  }
  return BigInt(Math.round(n));
}

/// The platform's share of `amount` (micro-USDC), floor-divided as on-chain.
export function platformFeeOf(amount: bigint): bigint {
  return (amount * platformFeeBps()) / 10_000n;
}
