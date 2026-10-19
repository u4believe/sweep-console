import { createPublicClient, defineChain, http, type Hex } from "viem";

// ─── Arc chain definitions ────────────────────────────────────────────────────

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.io"] },
  },
  testnet: true,
});

// Mainnet lives on arc.io. The old default pointed at rpc.arc.network, a host
// with no mainnet record at all, so setting ARC_NETWORK=mainnet failed at DNS
// with a bare "fetch failed" rather than saying what was wrong. Circle's primary
// endpoint is the default; ARC_MAINNET_RPC_URL takes one of the published
// alternates instead (dRPC rpc.drpc.mainnet.arc.io, and Blockdaemon and QuickNode
// on the same pattern). Both networks now sit on arc.io: rpc.testnet.arc.network
// still answers today, but arc.network has no mainnet record at all, so that
// family looks like it is being retired and was the next default due to break.
const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ARC_MAINNET_RPC_URL ?? "https://rpc.mainnet.arc.io"] },
  },
});

/**
 * The Arc chain this deployment runs against, RPC included.
 *
 * Exported because cctp.ts built its own and hardcoded the TESTNET endpoint
 * while taking the chain id from arcChainId(), which is network-aware. On
 * mainnet that produced a client for chain 5042 pointed at
 * rpc.testnet.arc.io — every mint would have gone to the wrong network, at
 * the last step of settlement, after the money had already moved.
 *
 * One definition means the id and the endpoint cannot disagree again.
 */
export function arcChain() {
  return process.env.ARC_NETWORK === "mainnet" ? arcMainnet : arcTestnet;
}

function chain() {
  return arcChain();
}

// ─── Clients ──────────────────────────────────────────────────────────────────

export function getUsdcAddress(): Hex {
  return (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as Hex;
}

export function getPublicClient() {
  return createPublicClient({ chain: chain(), transport: http() });
}


