import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import {
  fetchLinkedSubscriptions,
  revokeLinkedSubscription,
  type LinkedAccount,
  type LinkedSubscription,
} from "@/lib/gateway";

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
}

// Shown once the customer's email is OTP-verified: their on-file identity (full,
// un-masked email + the wallet on file) and any active subscriptions, each with a
// Revoke button. Upgrades are auto-replaced at checkout completion regardless, so
// this panel is explicit control + transparency before the customer re-subscribes.
export function ManageSubscriptionsPanel({ sessionId, email, emailToken, connectedWallet }: Props) {
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

  const onRevoke = async (sub: LinkedSubscription) => {
    setError("");
    setRevokingId(sub.id);
    try {
      await revokeLinkedSubscription(sessionId, sub.id, email, emailToken);
      load(); // refresh — the revoked sub drops off the active list
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke. Try again.");
    } finally {
      setRevokingId(null);
    }
  };

  // Stay silent until we know there's an existing subscription worth showing.
  if (loading || !account?.proven || account.subscriptions.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-amber-900">Your existing subscription</p>
        <span className="truncate text-xs text-amber-700">{account.email}</span>
      </div>
      <p className="mb-3 text-xs text-amber-700">
        Subscribing again replaces this automatically — or revoke it now to be sure.
      </p>

      <div className="space-y-2">
        {account.subscriptions.map((s) => {
          const isConnected =
            !!connectedWallet && s.wallet_address.toLowerCase() === connectedWallet.toLowerCase();
          return (
            <div key={s.id} className="rounded-lg bg-white p-3 ring-1 ring-amber-100">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">
                    {s.plan.name}
                    {s.status !== "active" && (
                      <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-gray-500">
                        {s.status}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">
                    ${formatUnits(BigInt(s.plan.amount), 6)} {s.plan.currency}{" "}
                    {INTERVAL_LABELS[s.plan.interval] ?? ""}
                  </p>
                  {/* Wallet on file — shown in full (not masked), per identity reveal. */}
                  <p className="mt-1 break-all font-mono text-[11px] text-gray-400">
                    {s.wallet_address}
                    {isConnected && <span className="text-brand-600"> · connected</span>}
                  </p>
                  {s.permissions.cross_chain_grants > 0 && (
                    <p className="text-[11px] text-gray-400">
                      {s.permissions.cross_chain_grants} cross-chain renewal grant
                      {s.permissions.cross_chain_grants > 1 ? "s" : ""}
                    </p>
                  )}
                </div>

                {/* Revoke — bottom-right of the card. */}
                {s.revocable && (
                  <button
                    onClick={() => onRevoke(s)}
                    disabled={revokingId === s.id}
                    className="shrink-0 self-end rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {revokingId === s.id ? "Revoking…" : "Revoke"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <p className="mt-2 text-[11px] text-amber-600">
        Gas is covered by the platform — revoking is free.
      </p>
    </div>
  );
}
