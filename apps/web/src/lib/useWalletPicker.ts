import { useCallback, useRef } from "react";
import { useAccountModal, useChainModal, useConnectModal } from "@rainbow-me/rainbowkit";
import { useDisconnect } from "wagmi";

/**
 * Open the right wallet modal, whatever state the wallet is in.
 *
 * RainbowKit hands back `undefined` rather than a no-op for an opener that does
 * not apply right now:
 *
 *   openConnectModal  only while disconnected or unauthenticated
 *   openAccountModal  only while connected AND on a configured chain
 *   openChainModal    for the wrong-network case
 *
 * So `openConnectModal?.()` — the obvious thing to write — is silently a no-op
 * for every already-connected subscriber, which is exactly who presses a button
 * labelled "Switch". Nothing throws and nothing opens.
 *
 * The ref matters as much as the fallback chain. These openers are swapped as
 * the connection state changes, so a handler defined during a connected render
 * captures `openConnectModal: undefined` and keeps it even after a disconnect.
 * Reading through a ref means the click uses whatever is current, not whatever
 * existed when the component last rendered.
 */
export function useWalletPicker(): () => void {
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const { openChainModal } = useChainModal();
  const { disconnect } = useDisconnect();

  const latest = useRef({ openConnectModal, openAccountModal, openChainModal });
  latest.current = { openConnectModal, openAccountModal, openChainModal };

  return useCallback(() => {
    const now = latest.current;
    // Connected: the account modal is the one with "Disconnect" in it, which is
    // how RainbowKit expects a person to change wallets.
    if (now.openAccountModal) return now.openAccountModal();
    if (now.openConnectModal) return now.openConnectModal();
    // Connected to a chain we do not configure — RainbowKit offers only this.
    if (now.openChainModal) return now.openChainModal();

    // Nothing is available: drop the connection, which makes the connect modal
    // exist again. It does not appear synchronously, so wait for it rather than
    // firing into the gap — the previous attempt at this used a fixed 200ms
    // timeout over a captured `undefined` and opened nothing.
    disconnect();
    let tries = 0;
    const timer = setInterval(() => {
      const open = latest.current.openConnectModal;
      if (open || (tries += 1) > 25) {
        clearInterval(timer);
        open?.();
      }
    }, 80);
  }, [disconnect]);
}
