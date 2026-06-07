"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { arcTestnet, arcMainnet } from "./chain/config";

export const wagmiConfig = getDefaultConfig({
  appName: "SweepConsole",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "demo",
  chains: [arcTestnet, arcMainnet],
  ssr: true,
});
