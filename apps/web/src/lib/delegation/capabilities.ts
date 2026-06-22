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
 * permission on. Returns the set of supported chain IDs (empty ⇒ the wallet
 * doesn't speak 7715, so Tier 2 is unavailable and checkout falls back to Tier 1).
 *
 * We do NOT gate on the wallet's currently-connected chain: renewal mandates are
 * granted per source chain (Base/Arbitrum/OP Sepolia), and the active chain is
 * often Arc — which wallets don't advertise 7715 for. The caller filters the grant
 * targets against this set, so any unsupported chain (e.g. Arc) is simply skipped.
 */
export async function getSupportedDelegationChainIds(client: Client): Promise<number[]> {
  try {
    const provider = client.extend(erc7715ProviderActions());
    const supported = await provider.getSupportedExecutionPermissions();
    if (!supported) return [];
    // supported: Record<permissionType, { chainIds: number[]; ruleTypes: string[] }>.
    const ids = new Set<number>();
    for (const info of Object.values(supported)) {
      for (const id of info?.chainIds ?? []) ids.add(id);
    }
    return [...ids];
  } catch {
    return [];
  }
}
