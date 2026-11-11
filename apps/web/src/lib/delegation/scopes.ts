// Tier-2 renewal mandate — builds the ERC-7715 permission request consumed by
// the MetaMask Smart Accounts Kit's `requestExecutionPermissions([...])`.
//
// IMPORTANT: MetaMask delivers ERC-7715 through the Smart Accounts Kit (the
// renamed @metamask/delegation-toolkit) over the `wallet_requestExecutionPermissions`
// RPC — see grant.ts. The `erc20-token-periodic` type is one of MetaMask's
// supported permission types: the delegate may transfer up to `periodAmount` of
// the token per `periodDuration`, resetting each period, until `expiry`.
//
// We pin the request to the SDK's own `PermissionRequestParameter` /
// `Erc20TokenPeriodicPermission` types so any future API drift surfaces here at
// compile time rather than at runtime in the wallet.

import { type Address } from "viem";
import type { PermissionRequestParameter } from "@metamask/smart-accounts-kit/actions";

/**
 * ONE ERC-7715 PERMISSION, BUILT FROM METAMASK'S DOCUMENTED EXAMPLE.
 *
 * Rewritten from the guide rather than grown from it. The guide for
 * erc20-token-periodic passes exactly five things — chainId, expiry, to, and a
 * permission of {type, data, isAdjustmentAllowed} — and the request this file
 * had accumulated differed from that in four places at once: it sent a
 * `redeemer` rule, sometimes a `payee` rule, a `startTime` the guide omits,
 * and isAdjustmentAllowed inverted.
 *
 * Each of those had a reason, and each reason was ours rather than the
 * wallet's. Undocumented fields are not forbidden — the kit types them and
 * builds rules from them — but a request that differs from the documented one
 * in four ways cannot be debugged, because every failure has four candidate
 * causes and the wallet reports none of them. Two were chased for a week:
 * `payee` with two addresses stops the prompt appearing at all, and the extra
 * fields were blamed for a 4100 that turned out to be a Coinbase-delegated
 * account failing the 7702 upgrade, a step earlier in the flow entirely.
 *
 * So the base is the documented request, and every addition is opt-in, named,
 * and justified at its own field. What a deployment sends is then a short list
 * of deliberate choices instead of an archaeology problem.
 */
export interface PeriodicErc20MandateInput {
  /* ── The documented five ────────────────────────────────────────────────── */

  chainId: number;
  /** ERC-20 to spend. USDC on the payer's chain. */
  token: Address;
  /**
   * The session account the permission is granted TO — `to` in the guide,
   * which MetaMask's prompt labels Recipient.
   *
   * It is the delegate: the account that will call redeemDelegations. The
   * DelegationManager checks the caller against this, so it is the constraint
   * on who may collect, not a destination for funds — a distinction the word
   * "Recipient" actively obscures for a payer reading the prompt.
   */
  delegate: Address;
  periodAmountMicro: bigint;
  periodDurationSec: number;
  expirySec: number;
  /** Shown to the payer in the prompt. Write it for them, not for us. */
  justification: string;

  /* ── Deliberate departures, all off by default ─────────────────────────── */

  /**
   * Addresses the transfer may pay, pinned as an AllowedCalldataEnforcer
   * caveat. EXACTLY ONE OR NONE.
   *
   * Two was reproduced as fatal: MetaMask takes a list in its types, forwards
   * it verbatim, and the permission prompt never appears. One worked for as
   * long as this platform has had grants, and the prompt then names the payee
   * instead of the delegate — which is the better thing for a payer to see.
   *
   * It is off by default because direct settlement pays two destinations, the
   * creator and the treasury, and one pin cannot cover both: the fee transfer
   * would be refused and take the creator's payment down with it. See
   * redeemableFee in the API's direct-settlement.ts, which zeroes a fee the
   * pin would refuse rather than reverting the renewal.
   */
  payees?: Address[];
  /**
   * `redeemer` rule, naming who may redeem.
   *
   * Undocumented, and REDUNDANT with `delegate` above: the DelegationManager
   * already checks the caller against the delegation's own delegate field, and
   * inspect-grant.ts shows the address twice in every signed grant — once
   * there and once as RedeemerEnforcer terms.
   *
   * Removing it was blamed for a mainnet regression and then restored; the
   * diagnostic later put that failure at stage=upgrade, before the permission
   * request is made, so the evidence for it was never real. Off by default,
   * available if a wallet ever asks for it.
   */
  pinRedeemer?: boolean;
  /**
   * `startTime` in the permission data, which the guide omits.
   *
   * A period that starts now is what a subscription means, so sending it was
   * reasonable — but the guide's absence of it is the only shape the wallet is
   * documented to accept, and an unasked-for field is one more thing a
   * refusal could be about.
   */
  startTimeSec?: number;
  /**
   * `isAdjustmentAllowed`, which the guide sets TRUE and we set false.
   *
   * False is the product decision: a subscriber should not be able to lower
   * the limit below the plan's price and leave renewals failing. It stays
   * false, and is listed here because it is a departure and the next person
   * deserves to know it was chosen rather than inherited.
   */
  allowAdjustment?: boolean;
}

/**
 * Build the request. Nothing here is conditional on configuration — the
 * caller decides, and this returns what it was asked for.
 */
export function buildPeriodicPermission(
  input: PeriodicErc20MandateInput
): PermissionRequestParameter {
  return {
    chainId: input.chainId,
    to: input.delegate,
    expiry: input.expirySec,
    ...(input.pinRedeemer ? { redeemer: [input.delegate] } : {}),
    ...(input.payees?.length ? { payee: input.payees } : {}),
    permission: {
      type: "erc20-token-periodic",
      isAdjustmentAllowed: input.allowAdjustment ?? false,
      data: {
        tokenAddress: input.token,
        periodAmount: input.periodAmountMicro,
        periodDuration: input.periodDurationSec,
        ...(input.startTimeSec !== undefined ? { startTime: input.startTimeSec } : {}),
        justification: input.justification,
      },
    },
  };
}

export const INTERVAL_SECONDS: Record<string, number> = {
  daily: 86_400,
  weekly: 604_800,
  monthly: 2_592_000,
  yearly: 31_536_000,
};
