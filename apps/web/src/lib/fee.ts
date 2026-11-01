/**
 * The platform fee, as the site states it.
 *
 * The authoritative number is PLATFORM_FEE_BPS on the API — that is what the
 * billing code multiplies by, and nothing here affects a single charge. This is
 * the same figure for the marketing and docs copy, so changing the rate does not
 * mean hunting literals through four files and leaving one behind.
 *
 * Keep VITE_PLATFORM_FEE_BPS in step with PLATFORM_FEE_BPS. They are deliberately
 * separate variables: one is read by a server at charge time, the other is baked
 * into a static bundle at build time, and pretending a build-time constant can
 * track a server's runtime config is how a page ends up quoting a rate nobody
 * charges.
 */
const BPS = Number(import.meta.env.VITE_PLATFORM_FEE_BPS ?? "200");

/// "2%" — trailing zeros dropped, so 250 bps reads "2.5%" and 200 reads "2%".
export function feePercent(): string {
  return `${Number((BPS / 100).toFixed(2))}%`;
}

/// What the creator keeps: "98%".
export function creatorKeepsPercent(): string {
  return `${Number(((10_000 - BPS) / 100).toFixed(2))}%`;
}

/**
 * The fee taken off a given amount, and what is left, both to two decimals.
 *
 * The comparison on the landing page puts a real number beside a card
 * processor's, and "2.5%" next to "−$1.14" is not a comparison — one is a rate
 * and the other is money. Derived from the same BPS as feePercent() so the two
 * can never disagree on the page they share.
 */
export function feeOn(amount: number): string {
  return ((amount * BPS) / 10_000).toFixed(2);
}

/// What the creator banks on `amount` after the platform fee.
export function keepsOf(amount: number): string {
  return (amount - (amount * BPS) / 10_000).toFixed(2);
}
