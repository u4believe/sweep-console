import { createPublicClient, defineChain, http, type Hex } from "viem";

// ─── Arc chain definitions ────────────────────────────────────────────────────

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network/"] },
  },
  testnet: true,
});

// Mainnet lives on arc.io. The old default pointed at rpc.arc.network, a host
// with no mainnet record at all, so setting ARC_NETWORK=mainnet failed at DNS
// with a bare "fetch failed" rather than saying what was wrong. Circle's primary
// endpoint is the default; ARC_MAINNET_RPC_URL takes one of the published
// alternates instead (dRPC rpc.drpc.mainnet.arc.io, and Blockdaemon and QuickNode
// on the same pattern). Testnet keeps rpc.testnet.arc.network above, which still
// answers; it is also reachable at rpc.testnet.arc.io.
const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ARC_MAINNET_RPC_URL ?? "https://rpc.mainnet.arc.io"] },
  },
});

function chain() {
  return process.env.ARC_NETWORK === "mainnet" ? arcMainnet : arcTestnet;
}

// ─── Clients ──────────────────────────────────────────────────────────────────

export function getUsdcAddress(): Hex {
  return (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as Hex;
}

export function getPublicClient() {
  return createPublicClient({ chain: chain(), transport: http() });
}


