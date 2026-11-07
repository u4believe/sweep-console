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

/**
 * Monad mainnet. No testnet counterpart on purpose — see MAINNET_CHAINS.
 *
 * Verified against the chain itself rather than taken from a doc page:
 * rpc.monad.xyz reports chain id 143, and the USDC below answers name
 * "USDC", symbol "USDC", decimals 6.
 */
const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
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
  /**
   * Circle's own code for this chain, as its API wants it.
   *
   * Here rather than in lib/circle.ts because a chain is defined once. The
   * previous arrangement — one CIRCLE_BLOCKCHAIN for the whole deployment —
   * was correct only while every creator was paid on Arc. Under direct
   * settlement a creator is paid on whichever chain their subscriber used, so
   * a wallet registered on one chain reads empty on the other three.
   *
   * And it reads empty while holding money: a Circle EOA has ONE EVM address,
   * so USDC arrives whatever is registered. It is Circle's /balances and its
   * withdrawal that are per-chain. That is the failure this field exists to
   * stop — the same shape as the ETH-SEPOLIA default described in
   * lib/circle.ts, wrong in a way that succeeds.
   */
  circle: string;
}

const TESTNET_CHAINS: SourceChain[] = [
  {
    key: "optimism",
    name: "OP Sepolia",
    domain: 2,
    chain: optimismSepolia,
    usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    circle: "OP-SEPOLIA",
  },
  {
    key: "arbitrum",
    name: "Arbitrum Sepolia",
    domain: 3,
    chain: arbitrumSepolia,
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    circle: "ARB-SEPOLIA",
  },
  {
    key: "base",
    name: "Base Sepolia",
    domain: 6,
    chain: baseSepolia,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    circle: "BASE-SEPOLIA",
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
    circle: "OP",
  },
  {
    key: "arbitrum",
    name: "Arbitrum One",
    domain: 3,
    chain: arbitrum,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    circle: "ARB",
  },
  {
    key: "base",
    name: "Base",
    domain: 6,
    chain: base,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    circle: "BASE",
  },
  /**
   * MAINNET ONLY, AND NOT BY OVERSIGHT.
   *
   * Every other key appears in both tables, so a developer can exercise a
   * chain in sandbox before taking it live. Monad cannot be exercised that
   * way: it is here because MetaMask's smart-account upgrade and advanced
   * permissions support Monad on mainnet, and sandbox has no equivalent to
   * point at. getSourceChain("monad") therefore throws in test mode, which is
   * the honest answer rather than a silent fallback to another chain.
   *
   * Direct settlement is what makes this additive at all. The old path
   * required a CCTP route from here to Arc; this one pays the creator on the
   * chain the payer used, so a new chain needs USDC, an ERC-7710 delegation
   * and nothing else. The domain below is unused while
   * DIRECT_SETTLEMENT_ENABLED is on, and correct if it is ever off: CCTP's
   * TokenMessengerV2 is deployed on Monad at the same address as everywhere
   * else (checked on chain, same bytecode length as Base), so the bridged
   * path would work here too rather than failing after the funds were
   * pulled.
   *
   * BEING IN THIS TABLE DOES NOT OFFER IT. supportedSourceChains() filters by
   * SUPPORTED_SOURCE_CHAINS, whose default deliberately omits monad, so a
   * deployment has to ask:
   *
   *   SUPPORTED_SOURCE_CHAINS=arbitrum,base,optimism,monad
   *   DELEGATION_RPC_143=https://rpc.monad.xyz
   *
   * Without the RPC a redeem here throws from rpcUrlForChain. The delegate
   * MSCA derives to the same address on Monad as elsewhere (probe it with
   * scripts/probe-msca-address.ts) but is NOT deployed there yet; the first
   * UserOperation carries its initCode, so it self-deploys — which costs more
   * verification gas than a steady-state redeem, so fund the gas payer before
   * the first charge rather than after it.
   */
  {
    key: "monad",
    name: "Monad",
    domain: 15,
    chain: monad,
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    circle: "MONAD",
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

/**
 * Circle's code for a chain -> our key. "BASE" -> "base".
 *
 * Circle names chains its own way and its webhooks speak that language, so
 * anything arriving from Circle has to be translated before it is stored
 * beside our own rows. Derived from the same table rather than listed again:
 * a chain added there is translatable here, and one that is not simply
 * returns null instead of being stored under a key nothing else uses.
 *
 * Searches BOTH networks on purpose. A webhook is answered by whichever
 * deployment Circle calls, and a test-mode wallet's code is a testnet one —
 * matching only the active table would drop the mode this very row records.
 */
export function chainKeyForCircleCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const want = code.trim().toUpperCase();
  for (const c of [...MAINNET_CHAINS, ...TESTNET_CHAINS]) {
    if (c.circle.toUpperCase() === want) return c.key;
  }
  // Arc is not a source chain, so it is in neither table, but it is where
  // every Circle wallet lived before this migration.
  if (want === "ARC" || want === "ARC-TESTNET") return "arc";
  return null;
}

export function getSourceChain(key: string): SourceChain {
  const chain = supportedSourceChains().find((c) => c.key === key);
  if (!chain) throw new Error(`Unsupported source chain: ${key}`);
  return chain;
}

/// Arc's chain id (destination/settlement chain).
export function arcChainId(): number {
  return isMainnet() ? 5042 : 5042002;
}

/// Map an EVM chain id to its chain key ("arc" or a source key), or undefined
/// when it isn't a supported chain. Used to reconcile stored delegations
/// (keyed by chainId) with the selector (keyed by chainKey).
export function chainKeyForId(chainId: number): string | undefined {
  if (chainId === arcChainId()) return "arc";
  return supportedSourceChains().find((c) => c.chain.id === chainId)?.key;
}

/**
 * A chain id -> its key, whichever network it belongs to.
 *
 * chainKeyForId answers for the ACTIVE network, which is right for anything
 * serving a request: a testnet deployment should not recognise a mainnet
 * chain. It is wrong for anything reading rows that span both — an operator
 * script, a report — where the alternative is printing "8453" and leaving the
 * reader to translate.
 */
export function chainKeyForIdAnyNetwork(chainId: number): string | undefined {
  if (chainId === 5042 || chainId === 5042002) return "arc";
  return [...MAINNET_CHAINS, ...TESTNET_CHAINS].find((c) => c.chain.id === chainId)?.key;
}

/** True when this chain id belongs to the mainnet table. */
export function isMainnetChainId(chainId: number): boolean {
  return chainId === 5042 || MAINNET_CHAINS.some((c) => c.chain.id === chainId);
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

