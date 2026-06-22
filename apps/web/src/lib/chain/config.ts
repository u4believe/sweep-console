import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network/"],
    },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export const arcMainnet = defineChain({
  id: 5042001,
  name: "Arc",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_ARC_MAINNET_RPC_URL ?? "https://rpc.arc.network/"],
    },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://arcscan.app" },
  },
});
