// Source-chain registry for the CCTP V2 "Pay from other chains" checkout.
//
// Arc is always the destination and is consulted first (subscribers pay natively
// on Arc when they hold enough USDC there). When Arc is short, the subscriber
// pays from USDC held on one of these source chains: the relayer pulls it via a
// gasless ERC-3009 transferWithAuthorization, then CCTP-burns it to Arc. No
// Circle Gateway / unified balance is involved.
//
// Addresses below are the Circle TESTNET USDC deployments. Verify current
// mainnet addresses and Arc destination support at developers.circle.com/cctp
// before any mainnet rollout.

import { createPublicClient, defineChain, http, type Chain, type Hex, type PublicClient } from "viem";

// Chains defined inline (same pattern as the Arc definitions in
// lib/chain/contract.ts) — keeps the API build independent of viem/chains.

const optimismSepolia = defineChain({
  id: 11_155_420,
  name: "OP Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.optimism.io"] } },
  testnet: true,
});

const arbitrumSepolia = defineChain({
  id: 421_614,
  name: "Arbitrum Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rollup.arbitrum.io/rpc"] } },
  testnet: true,
});

const baseSepolia = defineChain({
  id: 84_532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
  testnet: true,
});

/// CCTP V2 domain ID for Arc (the destination domain of every bridge).
export const ARC_DOMAIN = 26;

export interface SourceChain {
  key: string; // stable identifier used in env vars, DB rows and the API
  name: string; // display name shown in the checkout plan
  domain: number; // CCTP domain ID
  chain: Chain;
  usdc: Hex;
}

const TESTNET_CHAINS: SourceChain[] = [
  {
    key: "optimism",
    name: "OP Sepolia",
    domain: 2,
    chain: optimismSepolia,
    usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
  },
  {
    key: "arbitrum",
    name: "Arbitrum Sepolia",
    domain: 3,
    chain: arbitrumSepolia,
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  },
  {
    key: "base",
    name: "Base Sepolia",
    domain: 6,
    chain: baseSepolia,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
];

/// Active source chains, filtered by SUPPORTED_SOURCE_CHAINS (comma list of
/// keys, e.g. "base,arbitrum,optimism"). "arc" entries are ignored — Arc is
/// always the destination and is consulted first natively.
export function supportedSourceChains(): SourceChain[] {
  const wanted = (process.env.SUPPORTED_SOURCE_CHAINS ?? "arbitrum,base,optimism")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== "arc");

  return TESTNET_CHAINS.filter((c) => wanted.includes(c.key));
}

export function getSourceChain(key: string): SourceChain {
  const chain = supportedSourceChains().find((c) => c.key === key);
  if (!chain) throw new Error(`Unsupported source chain: ${key}`);
  return chain;
}

/// Arc's chain id (destination/settlement chain).
export function arcChainId(): number {
  return process.env.ARC_NETWORK === "mainnet" ? 5042001 : 5042002;
}

/// Map an EVM chain id to its chain key ("arc" or a source key), or undefined
/// when it isn't a supported chain. Used to reconcile stored delegations
/// (keyed by chainId) with the selector (keyed by chainKey).
export function chainKeyForId(chainId: number): string | undefined {
  if (chainId === arcChainId()) return "arc";
  return supportedSourceChains().find((c) => c.chain.id === chainId)?.key;
}

const clients = new Map<string, PublicClient>();

/// Public client for a source chain. RPC overridable via RPC_URL_<KEY> env
/// (e.g. RPC_URL_BASE); defaults to the viem chain's public RPC.
export function getSourceClient(source: SourceChain): PublicClient {
  let client = clients.get(source.key);
  if (!client) {
    const rpcOverride = process.env[`RPC_URL_${source.key.toUpperCase()}`];
    client = createPublicClient({
      chain: source.chain,
      transport: http(rpcOverride),
    });
    clients.set(source.key, client);
  }
  return client;
}

