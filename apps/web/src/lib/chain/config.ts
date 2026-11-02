import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.io"],
    },
  },
  blockExplorers: {
    // Checked, not assumed: arcscan.app does not resolve and
    // testnet.arcscan.app 302s here. Both Arc explorers are Blockscout at
    // arc.io, which is also where the RPCs live.
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
  testnet: true,
});

export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_ARC_MAINNET_RPC_URL ?? "https://rpc.mainnet.arc.io"],
    },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
});
