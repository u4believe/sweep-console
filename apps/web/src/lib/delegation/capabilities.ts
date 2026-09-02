// Tier-2 capability detection.
//
// Recommending MetaMask raises the FUNNEL, but "the user picked MetaMask" is
// NOT proof the connected wallet+version can grant a delegation. Correctness
// comes from probing capabilities at runtime; the result decides Tier 2 vs the
// Tier-1 over-sweep fallback. We never assume — if detection is uncertain we
// return false and the user safely lands on Tier 1.
//
// The Smart Accounts Kit exposes the authoritative probe directly:
// `getSupportedExecutionPermissions()` (wallet_getSupportedExecutionPermissions)
// reports which permission types the wallet supports and on which chains. A
// wallet that doesn't speak ERC-7715 throws or returns nothing → false.

import { type Client } from "viem";
import { erc7715ProviderActions } from "@metamask/smart-accounts-kit/actions";

/**
 * Probe which chains the connected wallet can grant an ERC-7715 execution
 * permission on.
 *
 * Returns `null` when the probe is INCONCLUSIVE — the wallet doesn't implement
 * `wallet_getSupportedExecutionPermissions`, or answered with nothing. That is
 * not the same as "this wallet can't grant": MetaMask builds exist that refuse
 * the probe and then happily service `wallet_requestExecutionPermissions`. We
 * saw exactly that — a subscriber paid from Base, which requires a delegation,
 * while the probe reported no supported chains and the UI told them their
 * wallet couldn't authorize anything.
 *
 * So callers must treat `null` as "offer every chain and let the grant attempt
 * be the judge" — a failed grant is reported clearly and costs one declined
 * prompt, whereas hiding the option costs the feature outright. A non-null
 * array is authoritative and should be used to filter.
 *
 * We do NOT gate on the wallet's currently-connected chain: renewal mandates are
 * granted per source chain (Base/Arbitrum/OP Sepolia), and the active chain is
 * often Arc — which wallets don't advertise 7715 for.
 */
export async function getSupportedDelegationChainIds(client: Client): Promise<number[] | null> {
  try {
    const provider = client.extend(erc7715ProviderActions());
    const supported = await provider.getSupportedExecutionPermissions();
    if (!supported) return null;
    // supported: Record<permissionType, { chainIds: number[]; ruleTypes: string[] }>.
    const ids = new Set<number>();
    for (const info of Object.values(supported)) {
      for (const id of info?.chainIds ?? []) ids.add(id);
    }
    // An empty answer is no answer — a wallet that truly supports nothing and a
    // wallet that misreports look identical here, so stay inconclusive.
    return ids.size > 0 ? [...ids] : null;
  } catch {
    return null;
  }
}
