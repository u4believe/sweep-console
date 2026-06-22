// Tier-2 grant flow — performs the one-time ERC-7715 permission request via the
// MetaMask Smart Accounts Kit, and normalises the result into the fields the
// relayer needs to redeem each cycle: the permission `context`, the
// `delegationManager` it redeems against, and the `dependencies` (account
// factory + factoryData) it must include when first redeeming against an
// account that isn't deployed yet (e.g. a fresh EIP-7702 upgrade).
//
// MetaMask exposes ERC-7715 by EXTENDING a viem wallet client with
// `erc7715ProviderActions()` (which routes to the wallet's
// `wallet_requestExecutionPermissions` RPC) — the grant method is
// `requestExecutionPermissions` (the former `grantPermissions`).

import { type Address, type Client, type Hex } from "viem";
import {
  erc7715ProviderActions,
  type GetGrantedExecutionPermissionsResult,
} from "@metamask/smart-accounts-kit/actions";
import { buildPeriodicPermission, type PeriodicErc20MandateInput } from "./scopes";

export interface GrantedRenewalMandate {
  chainId: number;
  /** ERC-7710 permission context — the opaque blob the relayer redeems. */
  context: Hex;
  /** DelegationManager the context must be redeemed against. */
  delegationManager: Address;
  /** The account the permission is bound to (the subscriber's delegator account). */
  accountAddress: Address;
  /**
   * Account-deployment dependencies the relayer must supply on the first redeem
   * if the delegator account isn't on-chain yet (EIP-7702 / smart-account init).
   * Empty for an already-deployed account.
   */
  dependencies: { factory: Address; factoryData: Hex }[];
  expirySec: number;
  /** The raw granted entry, for inspection in the dev harness. */
  raw: unknown;
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

type GrantEntry = GetGrantedExecutionPermissionsResult[number];

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalize(
  entry: GrantEntry,
  input: PeriodicErc20MandateInput
): GrantedRenewalMandate {
  const e = entry as any;
  const context = (e?.context ?? e?.permissionsContext) as Hex | undefined;
  // 1.x returns delegationManager top-level; keep the legacy signerMeta path.
  const delegationManager = (e?.delegationManager ??
    e?.signerMeta?.delegationManager) as Address | undefined;
  const accountAddress = (e?.from ??
    e?.accountMeta?.address ??
    e?.address) as Address | undefined;
  const dependencies = (e?.dependencies ?? []) as {
    factory: Address;
    factoryData: Hex;
  }[];

  if (!context) throw new Error("Grant returned no permission context");
  if (!delegationManager) throw new Error("Grant returned no delegationManager");

  return {
    chainId: input.chainId,
    context,
    delegationManager,
    accountAddress: accountAddress ?? ZERO,
    dependencies,
    // The response does not echo the requested expiry — carry it from the input.
    expirySec: input.expirySec,
    raw: entry,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/// Request one ERC-7715 periodic permission. `client` is the connected wallet's
/// viem client (wagmi `useConnectorClient`); we extend it with the toolkit's
/// erc7715 actions to expose `requestExecutionPermissions`.
export async function grantRenewalMandate(
  client: Client,
  input: PeriodicErc20MandateInput
): Promise<GrantedRenewalMandate> {
  const provider = client.extend(erc7715ProviderActions());
  const granted = await provider.requestExecutionPermissions([
    buildPeriodicPermission(input),
  ]);
  const entry = Array.isArray(granted) ? granted[0] : granted;
  if (!entry) throw new Error("Wallet returned no permission");
  return normalize(entry, input);
}
