import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatUnits } from "viem";
import {
  fetchLinkedSubscriptions,
  type LinkedAccount,
} from "@/lib/gateway";
import { HAIRLINE } from "./CheckoutFrame";

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
 * The subscriber dismisses it and it is gone for that email; the standing row
 * under Email carries the warning from then on, and Manage subscription is
 * where anything is actually done about it. The backdrop deliberately does not
 * dismiss: a stray click outside a warning should not count as having read it.
 * Escape does, because a dialog that traps Escape is a dialog people fight.
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
  const hasSubs = !loading && !!account?.proven && account.subscriptions.length > 0;
  const open = hasSubs && !dismissed;

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

  if (!hasSubs || !account) return null;

  const many = account.subscriptions.length > 1;
  // hasSubs guarantees one, but the index signature does not say so.
  const headline = many
    ? `You already have ${account.subscriptions.length} active subscriptions here.`
    : `You already subscribe to ${account.subscriptions[0]?.plan.name ?? "a plan"}.`;

  const dialog = createPortal(
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
          {many ? "these" : "this"} automatically.
        </p>

        <div style={{ overflowY: "auto", minHeight: 0, display: "grid", gap: 10, margin: "2px 0" }}>
          {account.subscriptions.map((s) => {
            const isConnected =
              !!connectedWallet && s.wallet_address.toLowerCase() === connectedWallet.toLowerCase();
            return (
              <div
                key={s.id}
                style={{
                  minWidth: 0,
                  padding: "12px 14px",
                  border: "1px solid var(--color-divider)",
                  borderRadius: "var(--radius-md)",
                }}
              >
                <div>
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
              </div>
            );
          })}
        </div>

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

  return (
    <>
      {/* The standing reminder, once the dialog has been waved through. Built to
          the same geometry as a StepRow so it reads as part of the sequence
          rather than something pasted between two steps: 26px marker gutter,
          13px rhythm, hairline close. It stays for the rest of the checkout —
          the dialog is seen once, this is what carries the warning afterwards. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "26px 1fr",
          padding: "13px 0",
          borderBottom: HAIRLINE,
          alignItems: "center",
        }}
      >
        <span style={{ width: 9, height: 9, background: "var(--color-accent)", display: "block" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5 }}>
            {headline}{" "}
            <span style={{ color: "var(--color-neutral-700)" }}>
              Paying again replaces {many ? "them" : "it"}.
            </span>
          </span>
          {/* A new tab: this is mid-checkout, and navigating away would take the
              session with it. */}
          <a
            className="btn btn-secondary"
            href="/manage"
            target="_blank"
            rel="noreferrer"
            style={{ marginLeft: "auto", flex: "none" }}
          >
            Manage subscription{many ? "s" : ""}
          </a>
        </div>
      </div>

      {open && dialog}
    </>
  );
}
