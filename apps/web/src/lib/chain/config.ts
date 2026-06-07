import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Arc L1 chain definition (EVM-compatible, USDC as native gas)
export const arcTestnet = defineChain({
  id: Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID ?? 12345),
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: [process.env.ARC_TESTNET_RPC_URL ?? "https://rpc-testnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer-testnet.arc.io" },
  },
  testnet: true,
});

export const arcMainnet = defineChain({
  id: Number(process.env.NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID ?? 12346),
  name: "Arc",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: [process.env.ARC_MAINNET_RPC_URL ?? "https://rpc.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
});

function getChain(testMode: boolean) {
  return testMode ? arcTestnet : arcMainnet;
}

function getRpcUrl(testMode: boolean) {
  return testMode
    ? (process.env.ARC_TESTNET_RPC_URL ?? "https://rpc-testnet.arc.io")
    : (process.env.ARC_MAINNET_RPC_URL ?? "https://rpc.arc.io");
}

// Read-only client — used by billing engine and API to read on-chain state
export function getPublicClient(testMode = false) {
  return createPublicClient({
    chain: getChain(testMode),
    transport: http(getRpcUrl(testMode)),
  });
}

// Wallet client using the platform's private key — used by the billing engine to call renew()
export function getPlatformWalletClient(testMode = false) {
  const privateKey = process.env.PLATFORM_PRIVATE_KEY;
  if (!privateKey) throw new Error("PLATFORM_PRIVATE_KEY is not set");

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return createWalletClient({
    account,
    chain: getChain(testMode),
    transport: http(getRpcUrl(testMode)),
  });
}

export function getContractAddress(testMode: boolean): `0x${string}` {
  const addr = testMode
    ? process.env.SUBSCRIPTION_CONTRACT_TESTNET
    : process.env.SUBSCRIPTION_CONTRACT_MAINNET;
  if (!addr) throw new Error(`SUBSCRIPTION_CONTRACT_${testMode ? "TESTNET" : "MAINNET"} is not set`);
  return addr as `0x${string}`;
}

export function getUsdcAddress(testMode: boolean): `0x${string}` {
  const addr = testMode
    ? process.env.USDC_ADDRESS_TESTNET
    : process.env.USDC_ADDRESS_MAINNET;
  if (!addr) throw new Error(`USDC_ADDRESS_${testMode ? "TESTNET" : "MAINNET"} is not set`);
  return addr as `0x${string}`;
}
