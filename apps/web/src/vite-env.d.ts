/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID: string;
  readonly VITE_PLATFORM_WALLET_ADDRESS: string;
  readonly VITE_CIRCLE_APP_ID: string;
  readonly VITE_ARC_TESTNET_RPC_URL: string;
  readonly VITE_ARC_MAINNET_RPC_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
