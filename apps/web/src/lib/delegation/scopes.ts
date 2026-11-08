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

export interface PeriodicErc20MandateInput {
  chainId: number;
  token: Address;
  delegate: Address;
  /**
   * Addresses this permission may transfer to — or NONE, which is the default.
   *
   * The periodic permission bounds the token, the amount and the period, and
   * says nothing about the destination; this is the one ERC-7715 control that
   * does, mapped to an AllowedCalldataEnforcer caveat on the recipient bytes.
   *
   * A list because ERC-7715 types it as one. TWO DOES NOT WORK: MetaMask
   * forwards the value verbatim and the permission prompt never appears with
   * two addresses — proven on the sandbox, where one prompts and two do not.
   * So the atomic fee split and a pinned payee were never compatible.
   *
   * Usually empty now, and deliberately — see payeePinMode in the API's
   * direct-settlement.ts for the trade. In short: pinning the creator makes
   * their payout wallet permanent, because the address is baked into every
   * signed permission and changing it would kill every existing renewal;
   * nothing in the redeem needs the pin, since each one reads the creator
   * from the merchant row at redeem time; and the delegate is now an MSCA
   * owned by a non-exportable KMS key, which is what guards this instead.
   */
  payees?: Address[];
  periodAmountMicro: bigint;
  periodDurationSec: number;
  startTimeSec: number;
  expirySec: number;
  justification: string;
}

/// One entry for `requestExecutionPermissions([...])` — a recurring ERC-20
/// transfer mandate granted to `delegate` (our relayer). In ERC-7715 the grantee
/// is the top-level `to`; the per-period cap lives in the `erc20-token-periodic`
/// permission. `isAdjustmentAllowed: false` keeps the cap fixed at the plan
/// amount (the wallet UI cannot raise it).
export function buildPeriodicPermission(
  input: PeriodicErc20MandateInput
): PermissionRequestParameter {
  return {
    chainId: input.chainId,
    to: input.delegate,
    expiry: input.expirySec,
    // Only the delegate may redeem, and only the named payees may be paid.
    // Under direct settlement those are the creator and the treasury, so a
    // stolen delegate key can move a subscriber's USDC to the merchant they
    // subscribed to or to our fee address, and nowhere else — it cannot pay
    // itself.
    redeemer: [input.delegate],
    ...(input.payees?.length ? { payee: input.payees } : {}),
    permission: {
      type: "erc20-token-periodic",
      isAdjustmentAllowed: false,
      data: {
        tokenAddress: input.token,
        periodAmount: input.periodAmountMicro,
        periodDuration: input.periodDurationSec,
        startTime: input.startTimeSec,
        justification: input.justification,
      },
    },
  };
}

/** Map a plan interval string to seconds. */
export const INTERVAL_SECONDS: Record<string, number> = {
  daily: 86_400,
  weekly: 604_800,
  monthly: 2_592_000,
  yearly: 31_536_000,
};
