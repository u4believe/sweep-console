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
