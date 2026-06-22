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

  const candidates = balances.chains.filter((c) => !allowed || allowed.has(c.chainKey));

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
