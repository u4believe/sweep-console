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

const arcMainnet = defineChain({
  id: 5042001,
  name: "Arc",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ARC_MAINNET_RPC_URL ?? "https://rpc.arc.network/"] },
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


