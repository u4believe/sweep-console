// Source-chain registry for the CCTP V2 "Pay from other chains" checkout.
//
// Arc is always the destination and is consulted first (subscribers pay natively
// on Arc when they hold enough USDC there). When Arc is short, the subscriber
// pays from USDC held on one of these source chains: the relayer pulls it via a
// gasless ERC-3009 transferWithAuthorization, then CCTP-burns it to Arc. No
// Circle Gateway / unified balance is involved.
//
// Two tables — Circle's testnet deployments and the mainnet ones — chosen by
// ARC_NETWORK, which is the same variable contract.ts switches Arc on. One
// switch for both legs on purpose: a deployment that was mainnet on the source
// side and testnet on the Arc side would burn testnet USDC toward Arc mainnet.
//
// The mainnet entries are the NATIVE USDC deployments, the only ones CCTP can
// burn and mint. They are deliberately not USDC.e, the bridged token that still
// exists on Arbitrum and Optimism: an address swapped for its bridged twin fails
// at the burn, not at boot. Check both tables against developers.circle.com/cctp
// before the first live charge.

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

const optimism = defineChain({
  id: 10,
  name: "OP Mainnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.optimism.io"] } },
});

const arbitrum = defineChain({
  id: 42_161,
  name: "Arbitrum One",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://arb1.arbitrum.io/rpc"] } },
});

const base = defineChain({
  id: 8_453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
});

/// CCTP V2 domain ID for Arc (the destination domain of every bridge). Arc is
/// live on both networks and keeps domain 26 on each, so this needs no branch.
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

// Same `key` and the same CCTP `domain` as the testnet row above: a CCTP domain
// identifies the chain, not the network, so only the chain definition and the
// USDC address differ between the two tables.
const MAINNET_CHAINS: SourceChain[] = [
  {
    key: "optimism",
    name: "OP Mainnet",
    domain: 2,
    chain: optimism,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  {
    key: "arbitrum",
    name: "Arbitrum One",
    domain: 3,
    chain: arbitrum,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  {
    key: "base",
    name: "Base",
    domain: 6,
    chain: base,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
];

/// True when this deployment is pointed at mainnet. Read by both the source
/// table and arcChainId(), so the two cannot disagree.
export function isMainnet(): boolean {
  return process.env.ARC_NETWORK === "mainnet";
}

/// The table for the network this deployment runs on.
function networkChains(): SourceChain[] {
  return isMainnet() ? MAINNET_CHAINS : TESTNET_CHAINS;
}

/// Active source chains, filtered by SUPPORTED_SOURCE_CHAINS (comma list of
/// keys, e.g. "base,arbitrum,optimism"). "arc" entries are ignored — Arc is
/// always the destination and is consulted first natively.
export function supportedSourceChains(): SourceChain[] {
  const wanted = (process.env.SUPPORTED_SOURCE_CHAINS ?? "arbitrum,base,optimism")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== "arc");

  return networkChains().filter((c) => wanted.includes(c.key));
}

export function getSourceChain(key: string): SourceChain {
  const chain = supportedSourceChains().find((c) => c.key === key);
  if (!chain) throw new Error(`Unsupported source chain: ${key}`);
  return chain;
}

/// Arc's chain id (destination/settlement chain).
export function arcChainId(): number {
  return isMainnet() ? 5042001 : 5042002;
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

