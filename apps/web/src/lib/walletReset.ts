import { disconnect } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";
import { ApiError } from "@/lib/errors";

/**
 * Wallet state that outlives the wallet.
 *
 * THE CAUSE OF THE 4100 THAT SURVIVED A METAMASK REINSTALL. RainbowKit's
 * MetaMask option runs through the MetaMask SDK connector, which caches the
 * account in this site's localStorage (`.MMSDK_cached_address`,
 * `providerType`, `.sdk-comm`), and wagmi persists its connection in
 * `wagmi.store`. Uninstalling MetaMask clears MetaMask. It does not clear
 * this origin's storage — so the page went on believing it was connected to
 * the OLD address, and every permission request named an account the new
 * wallet had never authorized for this site. MetaMask answers that with 4100,
 * before showing a prompt, every time.
 *
 * Re-authorizing could not help: the reconnect returns the wallet's real
 * account, which is never the stale one the request was built for.
 */
const STALE_KEY = /^(wagmi\.|rk-|\.?MMSDK|providerType$|\.sdk-comm|walletconnect|wc@2|-walletlink)/;

/** Remove every persisted trace of a wallet connection from this origin. */
export function clearWalletStorage(): string[] {
  const removed: string[] = [];
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && STALE_KEY.test(k)) {
        localStorage.removeItem(k);
        removed.push(k);
      }
    }
  } catch {
    /* Storage blocked (private window, policy). Nothing persisted, nothing to clear. */
  }
  return removed;
}

/** Clear the stale state AND drop the live connection, so the next connect starts clean. */
export async function resetWalletConnection(): Promise<void> {
  const removed = clearWalletStorage();
  try {
    await disconnect(wagmiConfig);
  } catch {
    /* Already disconnected is the outcome we wanted. */
  }
  // Disconnect can re-persist a key or two on its way out; sweep once more.
  removed.push(...clearWalletStorage());
  console.warn(`[wallet] reset the connection; cleared ${removed.length} persisted key(s)`, removed);
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The page and the wallet disagree about who is connected.
 *
 * An ApiError so friendlyError shows its message as written: it is already
 * the explanation, and names both addresses so the person can see which one
 * the page was holding on to.
 */
export class WalletAccountMismatchError extends ApiError {
  constructor(
    readonly expected: string,
    readonly actual: string | null,
  ) {
    super(
      actual
        ? `Your wallet is using ${short(actual)}, but this page was still holding ${short(expected)} ` +
            `from an earlier connection. We've cleared it — connect your wallet again to continue.`
        : `Your wallet isn't sharing an account with this page. We've reset the connection — ` +
            `connect your wallet again to continue.`,
    );
    this.name = "WalletAccountMismatchError";
  }
}
