import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  coinbaseWallet,
  walletConnectWallet,
  rainbowWallet,
  injectedWallet,
} from "@rainbow-me/rainbowkit/wallets";
import {
  base, arbitrum, optimism, monad,
  baseSepolia, arbitrumSepolia, optimismSepolia,
} from "viem/chains";
import { arcMainnet, arcTestnet } from "./chain/config";

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
  /**
   * Both networks, because one build serves both deployments.
   *
   * This listed only the testnets, so a live checkout asking the wallet to
   * switch to Base failed with "Chain not configured" and no prompt ever
   * appeared — wagmi cannot switch to a chain it has never been told about.
   *
   * Listing both is safe: the checkout only ever asks for a chain the API
   * offered, and the API offers one network's chains. A wallet knowing about
   * Base Sepolia while paying on Base costs nothing.
   */
  chains: [
    // Monad is mainnet-only — see MAINNET_CHAINS in the API's gateway/chains.ts.
    // There is no sandbox counterpart to list beside the Sepolias below.
    arcMainnet, base, arbitrum, optimism, monad,
    arcTestnet, baseSepolia, arbitrumSepolia, optimismSepolia,
  ],
});
