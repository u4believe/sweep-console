import { useState } from "react";
import { ExternalWalletVerify } from "./ExternalWalletVerify";
import { ErrorNote } from "./primitives";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";

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

  async function handleUnlink() {
    // No window.confirm here: apiFetch raises the step-up prompt, which names
    // the action and demands the authenticator. A native dialog in front of it
    // was a second, weaker confirmation for the same click.
    setLoading(true);
    clearError();
    const res = await apiFetch(`/portal/wallet/unlink`, { method: "POST" });
    setLoading(false);
    if (!res.ok) {
      // Guarded — leaving the payout address unset holds every future payout,
      // so a stolen session must not be able to do it silently.
      if (!(await wasCancelled(res))) setError(await messageOf(res, "Failed to unlink. Please try again."));
      return;
    }
    setAddress(null);
    setVerifiedAt(null);
    setMode("view");
  }

  async function handleRelinkCircle() {
    setMode("relinking");
    clearError();
    const res = await apiFetch(`/portal/wallet/relink-circle`, { method: "POST" });
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

  const verifiedLabel = verifiedAt
    ? `Verified ${new Date(verifiedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : "Unverified";

  return (
    <div>
      <div className="flex flex-wrap items-start gap-4" style={{ marginBottom: 18 }}>
        <div className="min-w-0">
          <h3 className="m-0" style={{ fontSize: 20, letterSpacing: "-0.02em", marginBottom: 4 }}>
            Payout wallet
          </h3>
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
            Every settled charge lands here. Sweep Console never custodies your balance.
          </p>
        </div>
        {isLinked && (
          <div className="ml-auto flex shrink-0 flex-wrap gap-1.5">
            <span className="tag tag-neutral">{hasCircleWallet ? "Circle" : "External"}</span>
            <span className={`tag ${isVerified ? "tag-accent" : "tag-outline"}`}>{verifiedLabel}</span>
          </div>
        )}
      </div>

      {error && <div style={{ marginBottom: 16 }}><ErrorNote>{error}</ErrorNote></div>}

      {/* ── Linked state ── */}
      {isLinked && (
        <div style={{ border: "2px solid var(--color-divider)", background: "var(--color-surface)", padding: 20 }}>
          <div className="flex flex-wrap items-center gap-3">
            <span style={{ width: 10, height: 10, flex: "none", display: "block", background: "var(--color-accent)" }} />
            <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, wordBreak: "break-all" }}>
              {address}
            </span>
          </div>

          {!isVerified && !hasCircleWallet && (
            <p
              className="m-0"
              style={{
                fontSize: 12.5, color: "var(--color-neutral-800)", lineHeight: 1.6,
                marginTop: 14, paddingLeft: 12, borderLeft: "3px solid var(--color-accent)",
              }}
            >
              This address was linked before ownership verification existed. Funds cannot be pushed
              to it until you verify it — use &ldquo;Use a different address&rdquo; below and sign
              with this wallet.
            </p>
          )}

          <div
            className="flex flex-wrap gap-2.5"
            style={{ marginTop: 16, borderTop: "1px solid var(--color-divider)", paddingTop: 16 }}
          >
            {mode !== "link-external" && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: "9px 14px" }}
                onClick={() => { setMode("link-external"); clearError(); }}
              >
                Use a different address
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}
              onClick={handleUnlink}
              disabled={loading}
            >
              {loading ? "Unlinking…" : "Unlink wallet"}
            </button>
          </div>
        </div>
      )}

      {/* ── Unlinked state ── */}
      {!isLinked && mode !== "link-external" && (
        <div style={{ border: "2px solid var(--color-divider)", background: "var(--color-surface)", padding: 20 }}>
          <p className="m-0" style={{ fontSize: 13, lineHeight: 1.6 }}>
            <strong style={{ fontFamily: "var(--font-heading)", fontWeight: 800 }}>No wallet linked.</strong>{" "}
            <span style={{ color: "var(--color-neutral-800)" }}>
              Revenue is held until you add one — nothing is lost in the meantime.
            </span>
          </p>
          <div
            className="flex flex-wrap gap-2.5"
            style={{ marginTop: 16, borderTop: "1px solid var(--color-divider)", paddingTop: 16 }}
          >
            {hasCircleWallet && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: "9px 14px" }}
                onClick={handleRelinkCircle}
                disabled={mode === "relinking"}
              >
                {mode === "relinking" ? "Re-linking…" : "Re-link Circle wallet"}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: "9px 14px" }}
              onClick={() => { setMode("link-external"); clearError(); }}
            >
              Link wallet address
            </button>
          </div>
        </div>
      )}

      {/* ── Link external: connect + sign-nonce ownership verification ── */}
      {mode === "link-external" && (
        <div style={{ marginTop: isLinked ? 18 : 0 }}>
          <ExternalWalletVerify
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
