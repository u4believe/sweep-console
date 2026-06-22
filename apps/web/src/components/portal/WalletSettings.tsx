import { useState } from "react";
import { ExternalWalletVerify } from "./ExternalWalletVerify";

interface Props {
  initialAddress: string | null;
  walletType: string;
  addressVerifiedAt: string | null;
}

type Mode = "view" | "link-external" | "relinking";

export function WalletSettings({ initialAddress, walletType, addressVerifiedAt }: Props) {
  const [address, setAddress] = useState(initialAddress);
  const [verifiedAt, setVerifiedAt] = useState(addressVerifiedAt);
  const [mode, setMode] = useState<Mode>("view");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const hasCircleWallet = walletType === "circle";
  const isLinked = !!address;
  const isVerified = !!verifiedAt;

  function clearError() { setError(""); }

  const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

  async function handleUnlink() {
    if (!confirm("Unlink your wallet? Revenue will be held until you link a new address.")) return;
    setLoading(true);
    clearError();
    const res = await fetch(`${apiUrl}/portal/wallet/unlink`, { method: "POST", credentials: "include" });
    setLoading(false);
    if (!res.ok) { setError("Failed to unlink. Please try again."); return; }
    setAddress(null);
    setVerifiedAt(null);
    setMode("view");
  }

  async function handleRelinkCircle() {
    setMode("relinking");
    clearError();
    const res = await fetch(`${apiUrl}/portal/wallet/relink-circle`, { method: "POST", credentials: "include" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error?.message ?? "Failed to re-link wallet");
      setMode("view");
      return;
    }
    setAddress(data.walletAddress as string);
    setVerifiedAt(new Date().toISOString());
    setMode("view");
  }

  return (
    <div className="card p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Payout Wallet</h2>
          <p className="mt-0.5 text-sm text-gray-500">
            USDC subscription revenue is credited to this address after each billing cycle.
          </p>
        </div>
        {isLinked && (
          <div className="flex shrink-0 gap-1.5">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                hasCircleWallet
                  ? "bg-blue-100 text-blue-700"
                  : "bg-gray-100 text-gray-600"
              }`}
            >
              {hasCircleWallet ? "Circle" : "External"}
            </span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                isVerified ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
              }`}
            >
              {isVerified ? "Verified" : "Unverified"}
            </span>
          </div>
        )}
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>
      )}

      {/* ── Linked state ── */}
      {isLinked && (
        <>
          <div className="rounded-lg bg-gray-50 px-4 py-3">
            <p className="mb-0.5 text-xs font-medium text-gray-500">Linked address</p>
            <code className="break-all font-mono text-sm text-gray-800">{address}</code>
          </div>

          {!isVerified && !hasCircleWallet && (
            <p className="mt-3 rounded-lg bg-yellow-50 px-4 py-3 text-sm text-yellow-700">
              This address was linked before ownership verification existed. Funds cannot be
              pushed to it until you verify it — use &ldquo;Use a different address&rdquo; below
              and sign with this wallet.
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              onClick={handleUnlink}
              disabled={loading}
              className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 transition"
            >
              {loading ? "Unlinking…" : "Unlink wallet"}
            </button>
            {mode !== "link-external" && (
              <button
                onClick={() => { setMode("link-external"); clearError(); }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                Use a different address
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Unlinked state ── */}
      {!isLinked && mode !== "link-external" && (
        <>
          <div className="mb-4 rounded-lg bg-yellow-50 px-4 py-3 text-sm text-yellow-700">
            No wallet linked — revenue will be held until you add one.
          </div>
          <div className="flex flex-wrap gap-3">
            {hasCircleWallet && (
              <button
                onClick={handleRelinkCircle}
                disabled={mode === "relinking"}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition"
              >
                {mode === "relinking" ? "Re-linking…" : "Re-link Circle wallet"}
              </button>
            )}
            <button
              onClick={() => { setMode("link-external"); clearError(); }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
            >
              Link wallet address
            </button>
          </div>
        </>
      )}

      {/* ── Link external: connect + sign-nonce ownership verification ── */}
      {mode === "link-external" && (
        <div className="mt-4">
          <ExternalWalletVerify
            requirePassword={isLinked}
            onLinked={(a) => {
              setAddress(a);
              setVerifiedAt(new Date().toISOString());
              setMode("view");
            }}
            onCancel={() => { setMode("view"); clearError(); }}
          />
        </div>
      )}
    </div>
  );
}
