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
/**
 * MINIMUM WALLET VERSIONS, because the permission TYPE decides them.
 *
 * `erc20-token-periodic` needs MetaMask >= v13.23.0 on the production
 * extension, or >= v13.5.0 on Flask. Flask is NOT required — older guides say
 * it is, and that was a development-era limitation.
 *
 * Worth writing down here, beside the request this file builds, because the
 * wallet reports a shortfall as EIP-1193 4100 "the requested method and/or
 * account has not been authorized" — which names no version, no permission
 * type and no remedy, and arrives identically on every chain. The Smart
 * Accounts Kit's own supported-networks table lists every chain this
 * deployment uses as supported from v1.5.0, so when a grant fails uniformly
 * it is the WALLET that is short, not the kit and not the chain.
 *
 * Source: docs.metamask.io/smart-accounts-kit/get-started/supported-advanced-permissions
 * Checked 8 Nov 2026 against kit v1.6.0.
 */
export function buildPeriodicPermission(
  input: PeriodicErc20MandateInput
): PermissionRequestParameter {
  /**
   * `redeemer` IS DELIBERATELY NOT SENT, and `payee` usually is not either.
   *
   * MetaMask documents exactly five parameters for
   * requestExecutionPermissions — chainId, from, expiry, permission and to
   * — and documents NEITHER `redeemer` NOR `payee`. Both exist in the kit's
   * types, which is why sending them type-checks, but a field the wallet
   * does not document is a field it is free to refuse.
   *
   * And it does refuse them. `payee` with two addresses stopped the
   * permission prompt appearing at all; one address brought it back.
   * `redeemer` then failed the request with EIP-1193 4100 — "the requested
   * method and/or ACCOUNT has not been authorized by the user" — on every
   * chain at once, on MetaMask 13.55.0, far above the v13.23.0 this
   * permission type needs. A rule naming an account the user has not
   * authorized is a plausible reading of that wording, and it was the last
   * undocumented field we sent.
   *
   * Dropping it costs nothing: `to` is the documented way to say which
   * account the permission is assigned to, so it already names the
   * delegate, and `redeemer: [input.delegate]` only repeated it. Nothing on
   * the redeem side reads it — every path recovers the delegate from the
   * signed context.
   */
  return {
    chainId: input.chainId,
    to: input.delegate,
    expiry: input.expirySec,
    // Omitted entirely unless the API asks for a pin, which by default it
    // does not — see payeePinMode in the API's direct-settlement.ts.
    // Under direct settlement those are the creator and the treasury, so a
    // stolen delegate key can move a subscriber's USDC to the merchant they
    // subscribed to or to our fee address, and nowhere else — it cannot pay
    // itself.
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
