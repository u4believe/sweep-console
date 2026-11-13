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

// The chains a subscriber can pay from. Arc is NOT among them any more: it was
// the settlement chain, settlement happens on the payer's own chain now, and
// leaving it listed meant a wallet could still be asked to add or switch to a
// network this platform never touches.
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
    base, arbitrum, optimism, monad,
    baseSepolia, arbitrumSepolia, optimismSepolia,
  ],
});
