// Single-chain payment selector (replaces dust aggregation).
//
// For a given charge, pick exactly ONE chain to pay from:
//   1. Arc first — it's the settlement chain, so no bridge and no wait.
//   2. Otherwise the first supported source chain whose OWN wallet balance
//      covers the full amount. No aggregation across chains, no fees (the
//      platform relayer pays gas).
//
// Used for both first-payment selection and, restricted to the chains the user
// granted a renewal delegation on, for each recurring renewal.

import type { Hex } from "viem";
import { scanWalletBalances } from "./balances";
import { getSourceChain, getSourceClient } from "./chains";

export type SelectedChain =
  | { kind: "arc" }
  | { kind: "source"; key: string; domain: number; name: string };

export interface ChainSelection {
  chain: SelectedChain;
  available: bigint; // wallet balance on the chosen chain
  sufficient: boolean; // available >= amount
}

export interface SelectOptions {
  amount: bigint;
  /** Restrict to these chain keys ("arc" + source keys). Omit ⇒ any supported. */
  allowedChainKeys?: string[];
  /**
   * For ERC-7715 source redeems: only pick a source chain where the subscriber's
   * smart account is actually deployed (7702-authorized). A codeless account makes
   * redeemDelegations revert with empty data. Arc is exempt (allowance/permit path).
   */
  requireDeployedAccount?: boolean;
}

export async function selectPaymentChain(
  subscriber: Hex,
  opts: SelectOptions
): Promise<ChainSelection> {
  const { amount } = opts;
  const allowed = opts.allowedChainKeys ? new Set(opts.allowedChainKeys) : null;
  const balances = await scanWalletBalances(subscriber);

  // Arc first — no bridge, no finality wait.
  if ((!allowed || allowed.has("arc")) && balances.arcBalance >= amount) {
    return { chain: { kind: "arc" }, available: balances.arcBalance, sufficient: true };
  }

  let candidates = balances.chains.filter((c) => !allowed || allowed.has(c.chainKey));

  // Drop source chains where the subscriber's smart account isn't deployed — a
  // redeem there would call codeless and revert with empty data.
  if (opts.requireDeployedAccount && candidates.length > 0) {
    const deployed = await Promise.all(
      candidates.map(async (c) => {
        try {
          const code = await getSourceClient(getSourceChain(c.chainKey)).getCode({ address: subscriber });
          return !!code && code !== "0x";
        } catch {
          return false;
        }
      })
    );
    candidates = candidates.filter((_, i) => deployed[i]);
  }

  // First source chain that alone covers the full amount.
  const pick = candidates.find((c) => c.walletBalance >= amount);
  if (pick) {
    return {
      chain: { kind: "source", key: pick.chainKey, domain: pick.domain, name: pick.chainName },
      available: pick.walletBalance,
      sufficient: true,
    };
  }

  // No single chain holds enough — report the deepest as the best (insufficient)
  // so callers can surface a meaningful shortfall.
  const deepest = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, c) => (!best || c.walletBalance > best.walletBalance ? c : best),
    undefined
  );
  if (deepest) {
    return {
      chain: { kind: "source", key: deepest.chainKey, domain: deepest.domain, name: deepest.chainName },
      available: deepest.walletBalance,
      sufficient: false,
    };
  }
  return { chain: { kind: "arc" }, available: balances.arcBalance, sufficient: false };
}
