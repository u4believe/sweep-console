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
 * rail, and two copies is how one gets fixed.
 */
import { isMainnet } from "../gateway/chains";

/** ArcScan, per network. The web app's chain config names the same pair. */
const DEFAULT_EXPLORER = {
  mainnet: "https://arcscan.app",
  testnet: "https://testnet.arcscan.app",
} as const;

export function explorerBase(): string {
  const override = process.env.ARC_EXPLORER_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  return isMainnet() ? DEFAULT_EXPLORER.mainnet : DEFAULT_EXPLORER.testnet;
}

/** A link to one transaction, or null when there is no hash to link to. */
export function explorerTxUrl(txHash: string | null | undefined): string | null {
  if (!txHash) return null;
  return `${explorerBase()}/tx/${txHash}`;
}
