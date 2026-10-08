import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatUnits } from "viem";
import {
  fetchLinkedSubscriptions,
  revokeLinkedSubscription,
  type LinkedAccount,
  type LinkedSubscription,
} from "@/lib/gateway";
import { friendlyError } from "@/lib/errors";

const INTERVAL_LABELS: Record<string, string> = {
  daily: "/ day",
  weekly: "/ week",
  monthly: "/ month",
  yearly: "/ year",
};

interface Props {
  sessionId: string;
  email: string;
  emailToken: string;
  connectedWallet?: string;
  /** The email whose subscriptions have already been acknowledged, if any. */
  acknowledged: string | null;
  onAcknowledge: (email: string) => void;
}

/**
 * What the subscriber is already paying for, asked before they pay again.
 *
 * A modal rather than a panel further down the column. As a panel it sat below
 * the fold of the thing it was warning about: someone who had already scrolled
 * past it to pick a chain never saw that they were about to replace a live
 * subscription. The decision belongs in front of the checkout, not under it.
 *
 * It closes two ways and no others — the subscriber dismisses it, or revokes
 * every subscription it lists (the list empties and the dialog has nothing left
 * to say). The backdrop deliberately does not dismiss: a stray click outside a
 * warning should not count as having read it. Escape does, because a dialog
 * that traps Escape is a dialog people fight.
 */
export function ManageSubscriptionsPanel({
  sessionId,
  email,
  emailToken,
  connectedWallet,
  acknowledged,
  onAcknowledge,
}: Props) {
  const [account, setAccount] = useState<LinkedAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetchLinkedSubscriptions(sessionId, email, emailToken)
      .then(setAccount)
      .catch(() => setAccount(null))
      .finally(() => setLoading(false));
  }, [sessionId, email, emailToken]);

  useEffect(() => {
    load();
  }, [load]);

  // Stay silent until we know there is an existing subscription worth blocking
  // on. The acknowledgement is held by the checkout and keyed by email, so it
  // survives this component remounting — opening and closing the balance sweep
  // swaps the whole payment column out and used to resurrect a dismissed
  // prompt — while a subscriber who verifies a DIFFERENT email is still asked
  // about that email's subscriptions.
  const dismissed = acknowledged === email;
  const open = !loading && !dismissed && !!account?.proven && account.subscriptions.length > 0;

  // Escape closes, and the page behind does not scroll while it is up — a modal
  // the wheel slides out from under is not blocking anything.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onAcknowledge(email);
    };
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, email, onAcknowledge]);

  const onRevoke = async (sub: LinkedSubscription) => {
    setError("");
    setRevokingId(sub.id);
    try {
      await revokeLinkedSubscription(sessionId, sub.id, email, emailToken);
      load(); // refresh — the revoked sub drops off the active list, and the
      // dialog closes itself once the last one goes.
    } catch (e) {
      setError(friendlyError(e, "Could not revoke. Try again."));
    } finally {
      setRevokingId(null);
    }
  };

  if (!open || !account) return null;

  const many = account.subscriptions.length > 1;

  return createPortal(
    <div className="dialog-backdrop" style={{ zIndex: 60 }} role="presentation">
      <div
        className="dialog swp-in"
        style={{ border: "2px solid var(--color-text)", width: "min(520px, 100%)", maxHeight: "86vh" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="existing-sub-title"
      >
        <p className="dialog-title m-0" id="existing-sub-title">
          You already {many ? "have subscriptions" : "have a subscription"}
        </p>

        <p className="dialog-body m-0">
          {account.email} is already subscribed. Paying again replaces{" "}
          {many ? "these" : "this"} automatically — or revoke{" "}
          {many ? "them" : "it"} now to be sure.
        </p>

        <div style={{ overflowY: "auto", minHeight: 0, display: "grid", gap: 10, margin: "2px 0" }}>
          {account.subscriptions.map((s) => {
            const isConnected =
              !!connectedWallet && s.wallet_address.toLowerCase() === connectedWallet.toLowerCase();
            return (
              <div
                key={s.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 14,
                  padding: "12px 14px",
                  border: "1px solid var(--color-divider)",
                  borderRadius: "var(--radius-md)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <p
                    className="m-0"
                    style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 14.5 }}
                  >
                    {s.plan.name}
                    {s.status !== "active" && (
                      <span className="tag tag-neutral" style={{ marginLeft: 8 }}>
                        {s.status}
                      </span>
                    )}
                  </p>
                  <p className="m-0" style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
                    {formatUnits(BigInt(s.plan.amount), 6)} {s.plan.currency}{" "}
                    {INTERVAL_LABELS[s.plan.interval] ?? ""}
                  </p>
                  {/* Wallet on file — shown in full, not masked: this is the
                      identity reveal the OTP paid for. */}
                  <p
                    className="m-0"
                    style={{
                      marginTop: 4,
                      fontFamily: "var(--font-mono, monospace)",
                      fontSize: 11,
                      color: "var(--color-neutral-700)",
                      wordBreak: "break-all",
                    }}
                  >
                    {s.wallet_address}
                    {isConnected && <span style={{ color: "var(--color-accent)" }}> · connected</span>}
                  </p>
                  {s.permissions.cross_chain_grants > 0 && (
                    <p className="m-0" style={{ fontSize: 11, color: "var(--color-neutral-700)" }}>
                      {s.permissions.cross_chain_grants} cross-chain renewal grant
                      {s.permissions.cross_chain_grants > 1 ? "s" : ""}
                    </p>
                  )}
                </div>

                {s.revocable && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ flex: "none", alignSelf: "center" }}
                    onClick={() => void onRevoke(s)}
                    disabled={revokingId === s.id}
                  >
                    {revokingId === s.id ? "Revoking…" : "Revoke"}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {error && (
          <p className="m-0" style={{ fontSize: 12.5, color: "var(--color-accent)" }}>
            {error}
          </p>
        )}

        <p className="m-0" style={{ fontSize: 11.5, color: "var(--color-neutral-700)" }}>
          Gas is covered by the platform — revoking is free.
        </p>

        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-primary"
            autoFocus
            onClick={() => onAcknowledge(email)}
          >
            Keep {many ? "them" : "it"} and continue
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
