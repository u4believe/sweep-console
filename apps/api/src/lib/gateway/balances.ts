// Balance Scanner.
//
// Parallel RPC reads of USDC balanceOf(subscriber) on every supported CCTP source
// chain (plus Arc). Exposed to checkout as GET /v1/wallet/balances and used by the
// single-chain payment selector.

import type { Hex } from "viem";
import { ERC20_ABI } from "../chain/abi";
import { getPublicClient, getUsdcAddress } from "../chain/contract";
import { getSourceClient, supportedSourceChains, type SourceChain } from "./chains";

export interface ChainBalance {
  chainKey: string;
  chainName: string;
  domain: number;
  walletBalance: bigint; // USDC in the subscriber's own wallet on that chain
  nativeBalance: bigint; // native gas token (wei) — informational
}

export interface WalletBalances {
  arcBalance: bigint; // USDC already on Arc (no sweep needed for this part)
  chains: ChainBalance[];
  total: bigint; // arc + all source-wallet USDC
}

async function readUsdcBalance(source: SourceChain, address: Hex): Promise<bigint> {
  try {
    const client = getSourceClient(source);
    return (await client.readContract({
      address: source.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
  } catch (e) {
    // An unreachable RPC must not break checkout — that chain just contributes 0
    console.warn(`[gateway/balances] ${source.key} read failed:`, (e as Error).message);
    return 0n;
  }
}

async function readNativeBalance(source: SourceChain, address: Hex): Promise<bigint> {
  try {
    return await getSourceClient(source).getBalance({ address });
  } catch {
    return 0n; // can't read → treat as no native gas → relayer pays
  }
}

export async function scanWalletBalances(address: Hex): Promise<WalletBalances> {
  const sources = supportedSourceChains();

  const [arcBalance, walletBalances, nativeBalances] = await Promise.all([
    // Arc-first: the destination chain's balance short-circuits the sweep
    getPublicClient()
      .readContract({
        address: getUsdcAddress(),
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      })
      .then((b) => b as bigint)
      .catch(() => 0n),
    Promise.all(sources.map((s) => readUsdcBalance(s, address))),
    Promise.all(sources.map((s) => readNativeBalance(s, address))),
  ]);

  const chains: ChainBalance[] = sources.map((s, i) => ({
    chainKey: s.key,
    chainName: s.name,
    domain: s.domain,
    walletBalance: walletBalances[i],
    nativeBalance: nativeBalances[i],
  }));

  const total = arcBalance + chains.reduce((sum, c) => sum + c.walletBalance, 0n);

  return { arcBalance, chains, total };
}
