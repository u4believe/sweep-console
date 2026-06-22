import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  coinbaseWallet,
  walletConnectWallet,
  rainbowWallet,
  injectedWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { baseSepolia, arbitrumSepolia, optimismSepolia } from "viem/chains";
import { arcTestnet } from "./chain/config";

// Arc is the subscription/destination chain. The CCTP V2 source chains are
// included so the wallet can switch to each one to sign its gasless ERC-3009
// transferWithAuthorization, which is an EIP-712 payload bound to that chain.
export const wagmiConfig = getDefaultConfig({
  appName: "SweepConsole",
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "demo",
  // MetaMask leads as the Recommended connector: it's the wallet furthest along
  // on EIP-7702 + ERC-7715/7710, which is the path to autonomous cross-chain
  // renewals (a one-time delegation grant, no per-period signature). This is a
  // soft nudge only — every other wallet still connects and checks out via the
  // over-sweep fallback. Whether a connected wallet can actually grant a
  // delegation is decided at runtime by a capability probe, NOT by this list.
  wallets: [
    { groupName: "Recommended", wallets: [metaMaskWallet] },
    {
      groupName: "Other wallets",
      wallets: [coinbaseWallet, walletConnectWallet, rainbowWallet, injectedWallet],
    },
  ],
  // Arc Testnet (destination) + the CCTP V2 "Pay from other chains" source testnets.
  chains: [arcTestnet, arbitrumSepolia, baseSepolia, optimismSepolia],
});
