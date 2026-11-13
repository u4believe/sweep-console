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

/**
 * MetaMask refused the permission AFTER the subscriber approved it.
 *
 * NOT OURS, AND NOT FIXABLE FROM HERE. MetaMask extension 13.55.0 changed its
 * permission checks to read accounts from the per-chain CAIP-25 scope, and
 * its preinstalled permissions snap only holds accounts under the wildcard
 * scope — so the snap finds no authorized account for the chain it is
 * granting on and throws 4100, after the prompt and after Grant was pressed.
 * Any account, clean install or not. Tracked upstream as
 * MetaMask/metamask-extension#47707, labelled regression-prod-13.55.0, open
 * with no fix at the time of writing.
 *
 * It is told apart from a genuine authorization problem by order: the grant
 * has already asked the wallet for its account (eth_requestAccounts) and got
 * the right one back, so the site and account ARE authorized when this
 * arrives. What is refused is MetaMask's own internal step.
 *
 * Said plainly because every earlier version of this message sent people to
 * reinstall MetaMask or reconnect the site — which installs the broken
 * version again, and reconnects a site that was never disconnected.
 */
export class MetaMaskGrantRefusedError extends ApiError {
  constructor(readonly clientVersion: string | null) {
    const v = clientVersion?.match(/v?(\d+\.\d+\.\d+)/)?.[1];
    super(
      `MetaMask${v ? ` ${v}` : ""} refused this permission after you approved it. This is a known ` +
        `bug in MetaMask 13.55.0 and later that MetaMask hasn't fixed yet — your wallet and this ` +
        `page are set up correctly, and nothing was charged for this permission. Please try a different wallet for ` +
        `now, or try again after MetaMask releases an update.`,
    );
    this.name = "MetaMaskGrantRefusedError";
  }
}
