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
