/**
 * Turn a chain revert into something a developer can act on.
 *
 * WHAT WAS STORED BEFORE. failureReason took the viem error verbatim, so the
 * Charges table showed a developer this:
 *
 *   redeem_failed: redeemDelegations reverted on chain 42161: The contract
 *   function "redeemDelegations" reverted with the following reason:
 *   AllowedCalldataEnforcer:invalid-calldata [raw: 0x08c379a0000…64617461]
 *
 * Three hundred characters, most of it a hex re-encoding of a string already
 * quoted in the line above, and nothing in it says what to do. The useful
 * part is eleven words long and it is the enforcer's name.
 *
 * So: known reverts get a sentence, and the raw text goes to the log, where
 * whoever is debugging the chain can still read it. An UNKNOWN revert keeps
 * its message — truncated, because an unrecognised failure is exactly when
 * the detail matters and inventing a friendly line for it would hide the one
 * clue there is.
 *
 * The enforcer names are the caveats this platform actually attaches:
 * AllowedCalldataEnforcer pins the payee, ERC20PeriodTransferEnforcer caps
 * the amount per period. Both appear in lib/chain/delegation.ts.
 */

/** Longest raw message kept when nothing matches. Two lines in a table cell. */
const RAW_LIMIT = 160;

const KNOWN: Array<{ match: RegExp; say: string }> = [
  {
    // The payee in the call does not equal the one pinned when the payer
    // signed. Caused the 2026-10-28 rail outage, when the charge asked for
    // the EOA and the grant pinned the MSCA.
    match: /AllowedCalldataEnforcer:invalid-calldata/i,
    say: "This mandate was signed to pay a different settlement address than the one this charge used. The payer must re-authorize before it can be charged.",
  },
  {
    match: /ERC20PeriodTransferEnforcer:transfer-amount-exceeded/i,
    say: "This period's spending limit is already used up. The next period resets it; charging more needs a new mandate.",
  },
  {
    match: /ERC20PeriodTransferEnforcer:transfer-not-started/i,
    say: "The mandate's first period has not started yet.",
  },
  {
    match: /TimestampEnforcer|expired|ExpiryEnforcer/i,
    say: "The payer's authorization has expired. They need to authorize again.",
  },
  {
    match: /transfer amount exceeds balance|insufficient (funds|balance)|ERC20: transfer amount/i,
    say: "The payer's wallet did not hold enough USDC on this chain.",
  },
  {
    match: /AA21|didn't pay prefund|prefund/i,
    say: "The settlement account could not cover gas. This is ours to fix, not the payer's — retry once it is topped up.",
  },
  {
    match: /AA33|paymaster|exceeds allowance/i,
    say: "The gas sponsor refused this operation. This is ours to fix — retry shortly.",
  },
  {
    match: /nonce too low|replacement transaction underpriced|already known/i,
    say: "A competing transaction used the same nonce. Safe to retry.",
  },
  {
    match: /DelegationManager|invalid signature|ECDSA/i,
    say: "The signed permission was rejected on chain. The payer may have revoked it from their wallet.",
  },
];

/**
 * A short reason for the Charges table and the charge.failed webhook.
 *
 * `raw` is still written to the server log by the caller, so nothing is lost.
 */
export function chargeFailureReason(raw: string): string {
  const hit = KNOWN.find((k) => k.match.test(raw));
  if (hit) return hit.say;

  // Unrecognised. Strip the hex blob — it is a re-encoding of the text that
  // precedes it — then keep what is left, bounded.
  const withoutHex = raw.replace(/\s*\[raw:\s*0x[0-9a-fA-F]+\]/g, "").trim();
  const oneLine = withoutHex.replace(/\s+/g, " ");
  return oneLine.length > RAW_LIMIT ? `${oneLine.slice(0, RAW_LIMIT - 1)}…` : oneLine;
}
