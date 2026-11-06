/**
 * The Arc block explorer for THIS deployment.
 *
 * THE BUG THIS FIXES: both receipt templates carried
 *
 *     process.env.ARC_EXPLORER_URL ?? "https://testnet.arcscan.app"
 *
 * so a live deployment that had not set ARC_EXPLORER_URL sent every customer
 * a receipt linking their mainnet transaction to the TESTNET explorer, where
 * it does not exist. The payer sees "View on explorer", clicks it, and is
 * told their payment cannot be found — which is the worst possible moment to
 * look untrustworthy, and it was the default rather than a misconfiguration.
 *
 * Defaulting to testnet is exactly backwards: an unset variable should fail
 * towards the deployment it is actually running on, and the deployment
 * already says which that is. ARC_NETWORK drives the chain set, the contract
 * addresses and the key prefix; it drives this now too. The env var stays as
 * an override for a private or renamed explorer.
 *
 * One module because there were two copies of the same line, hosted and
 * rail, and two copies is how one gets fixed. It lived under lib/email while
 * receipts were its only caller; GET /portal/withdrawals links a hash too, so
 * it sits at lib/ now rather than making a portal route import from email/.
 */
import { isMainnet } from "./gateway/chains";

/**
 * Arc's Blockscout explorers, per network.
 *
 * These were "https://arcscan.app" and "https://testnet.arcscan.app", copied
 * from apps/web/src/lib/chain/config.ts, which had the same pair. Checked
 * rather than trusted, and both were wrong:
 *
 *   arcscan.app                 does not resolve at all — a dead domain, so
 *                               the mainnet link was broken twice over
 *   testnet.arcscan.app         302s to explorer.testnet.arc.io
 *
 * So the canonical hosts are the arc.io ones, and the /tx/<hash> path is
 * right because both are Blockscout.
 */
const DEFAULT_EXPLORER = {
  mainnet: "https://explorer.arc.io",
  testnet: "https://explorer.testnet.arc.io",
} as const;

/**
 * An explorer per chain, because a hash only exists on one of them.
 *
 * ARC WAS THE ONLY ANSWER AND IS NOW THE MINORITY ONE. Settlement used to end
 * with a mint on Arc, so every hash worth linking was an Arc hash and a
 * single base URL was right. Under direct settlement the transaction stays on
 * the chain the payer used, so linking it to Arc reproduces exactly the bug
 * described above — "View on explorer" leading to a page that says the
 * transaction cannot be found — just with a different wrong host.
 *
 * Arc stays, and not for symmetry: 161 of 186 payments on this deployment
 * carry chain="arc" with hashes that resolve only there. Removing Arc is
 * retiring a path, not deleting a chain.
 *
 * Hosts checked rather than copied, which is how arcscan.app was caught. All
 * of these resolve; basescan answers 403 to curl, which is Cloudflare turning
 * away a bot rather than a dead domain.
 */
const CHAIN_EXPLORER: Record<string, { mainnet: string; testnet: string | null }> = {
  arc: { mainnet: DEFAULT_EXPLORER.mainnet, testnet: DEFAULT_EXPLORER.testnet },
  base: { mainnet: "https://basescan.org", testnet: "https://sepolia.basescan.org" },
  arbitrum: { mainnet: "https://arbiscan.io", testnet: "https://sepolia.arbiscan.io" },
  optimism: {
    mainnet: "https://optimistic.etherscan.io",
    testnet: "https://sepolia-optimism.etherscan.io",
  },
  // Mainnet only, like the chain itself — see MAINNET_CHAINS.
  monad: { mainnet: "https://monadscan.com", testnet: null },
};

/** The Arc explorer for this deployment. Kept for callers that mean Arc. */
export function explorerBase(): string {
  const override = process.env.ARC_EXPLORER_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  return isMainnet() ? DEFAULT_EXPLORER.mainnet : DEFAULT_EXPLORER.testnet;
}

/**
 * The explorer for one chain, or null where this deployment has none.
 *
 * `EXPLORER_URL_<KEY>` overrides any of them, as ARC_EXPLORER_URL always has
 * for Arc — a private or renamed explorer should not need a release.
 */
export function explorerBaseFor(chainKey: string): string | null {
  const key = (chainKey || "arc").toLowerCase();
  const override = process.env[`EXPLORER_URL_${key.toUpperCase()}`]?.trim();
  if (override) return override.replace(/\/+$/, "");
  if (key === "arc") return explorerBase();
  const entry = CHAIN_EXPLORER[key];
  if (!entry) return null;
  const url = isMainnet() ? entry.mainnet : entry.testnet;
  return url ? url.replace(/\/+$/, "") : null;
}

/**
 * A link to one transaction, or null when there is nothing to link to.
 *
 * `chainKey` defaults to "arc" so a caller that does not know stays exactly
 * as it was — which is correct for every row written before this migration,
 * and the reason this is a widening rather than a breaking change.
 *
 * Returns null for a chain with no explorer rather than guessing a host. A
 * dead link in a receipt is worse than no link: one looks broken, the other
 * looks like the payment is missing.
 */
export function explorerTxUrl(
  txHash: string | null | undefined,
  chainKey: string = "arc"
): string | null {
  if (!txHash) return null;
  const base = explorerBaseFor(chainKey);
  return base ? `${base}/tx/${txHash}` : null;
}
