import { useState } from "react";
import { ExternalWalletVerify } from "./ExternalWalletVerify";
import { ArcMark, BaseMark, ArbitrumMark, OptimismMark } from "@/components/landing/ChainMarks";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/**
 * Onboarding step 03 — the payout wallet — rendered in the Modernist system.
 *
 * Two paths, both non-custodial. "I have a wallet" links an address the
 * merchant already controls, proven with a gas-free signature. "Create a payout
 * wallet" provisions a Circle user-controlled wallet: Circle's own secure
 * window takes a PIN, the signing key is sharded, and nothing resembling a
 * private key or seed phrase is ever handed to us or to the merchant. The
 * design's generated-key copy (passphrase, recovery phrase, keystore download)
 * does not apply here and is deliberately absent.
 */

interface Props {
  /** A Circle wallet already exists for this account — only the link path is offered. */
  hasCircleWallet: boolean;
}

type Mode = "link" | "create";
type Phase = "idle" | "opening" | "waiting" | "done";

const SQUARE = { width: 10, height: 10, background: "var(--color-accent)", display: "block" } as const;

export function WalletSetupBanner({ hasCircleWallet }: Props) {
  const [mode, setMode] = useState<Mode>(hasCircleWallet ? "link" : "create");
  const [phase, setPhase] = useState<Phase>("idle");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");

  const busy = phase === "opening" || phase === "waiting";

  function finish(walletAddress: string) {
    setAddress(walletAddress);
    setPhase("done");
    setTimeout(() => window.location.reload(), 1400);
  }

  async function createCircleWallet() {
    setPhase("opening");
    setError("");

    try {
      const res = await fetch(`${API_URL}/portal/wallet/circle`, {
        method: "POST",
        credentials: "include",
      });
      let data: Record<string, unknown> = {};
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok) {
        throw new Error(
          (data.error as { message?: string } | undefined)?.message ?? "Couldn't start wallet creation."
        );
      }

      const payload = data as {
        userToken?: string;
        encryptionKey?: string;
        challengeId?: string;
        appId?: string;
        walletAddress?: string;
        alreadySetup?: boolean;
      };

      // The wallet already existed on Circle's side — the server saved it, no
      // PIN challenge to run.
      if (payload.alreadySetup) {
        finish(payload.walletAddress ?? "");
        return;
      }

      const { userToken, encryptionKey, challengeId, appId } = payload as {
        userToken: string;
        encryptionKey: string;
        challengeId: string;
        appId: string;
      };

      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const sdk = new W3SSdk();
      sdk.setAppSettings({ appId: import.meta.env.VITE_CIRCLE_APP_ID ?? appId });
      sdk.setAuthentication({ userToken, encryptionKey });

      setPhase("waiting");

      sdk.execute(challengeId, async (err) => {
        if (err) {
          setError(err.message ?? "Circle couldn't finish setting up the wallet.");
          setPhase("idle");
          return;
        }

        try {
          const confirmRes = await fetch(`${API_URL}/portal/wallet/circle/confirm`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ challengeId }),
            signal: AbortSignal.timeout(30_000),
          });
          const confirmData = (await confirmRes.json()) as {
            walletAddress?: string;
            error?: { message?: string };
          };
          if (!confirmRes.ok) throw new Error(confirmData.error?.message ?? "Couldn't save the wallet.");
          finish(confirmData.walletAddress ?? "");
        } catch (e) {
          setError(e instanceof Error ? e.message : "Couldn't save the wallet. Please try again.");
          setPhase("idle");
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("idle");
    }
  }

  if (phase === "done") {
    return (
      <div
        style={{
          border: "2px solid var(--color-accent)",
          background: "var(--color-surface)",
          padding: "20px",
        }}
      >
        <p className="m-0 flex flex-wrap items-center gap-3">
          <span style={SQUARE} />
          <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 15 }}>
            Payout wallet linked
          </span>
          {address && (
            <span
              style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, wordBreak: "break-all" }}
            >
              {address}
            </span>
          )}
        </p>
        <p className="m-0" style={{ marginTop: 8, fontSize: 12.5, color: "var(--color-neutral-700)" }}>
          Reloading your dashboard…
        </p>
      </div>
    );
  }

  return (
    <div>
      <p
        className="m-0 uppercase"
        style={{ fontSize: 10, letterSpacing: "0.16em", color: "var(--color-accent)", marginBottom: 8 }}
      >
        03 — Payout wallet
      </p>
      <h2
        className="m-0"
        style={{ fontSize: 26, letterSpacing: "-0.03em", lineHeight: 1.05, marginBottom: 8 }}
      >
        {mode === "create" ? "Create a payout wallet" : "Link your payout wallet"}
      </h2>
      <p
        className="m-0"
        style={{ fontSize: 14, color: "var(--color-neutral-800)", lineHeight: 1.6, marginBottom: 18, maxWidth: 560 }}
      >
        {mode === "create"
          ? "No wallet yet? Circle creates one for you. You set a PIN — there is no private key or seed phrase for you to keep."
          : "Settlements go straight to this address. Sweep Console never holds your balance."}
      </p>

      {!hasCircleWallet && (
        <div className="seg" style={{ marginBottom: 18 }}>
          <label className="seg-opt">
            <input
              type="radio"
              name="wallet-mode"
              checked={mode === "link"}
              disabled={busy}
              onChange={() => { setMode("link"); setError(""); }}
            />
            I have a wallet
          </label>
          <label className="seg-opt">
            <input
              type="radio"
              name="wallet-mode"
              checked={mode === "create"}
              disabled={busy}
              onChange={() => { setMode("create"); setError(""); }}
            />
            Create a payout wallet
          </label>
        </div>
      )}

      {error && (
        <p className="m-0" style={{ marginBottom: 14, fontSize: 13, color: "var(--color-accent-700)" }}>
          {error}
        </p>
      )}

      {mode === "link" ? (
        <div
          style={{
            border: "2px solid var(--color-divider)",
            padding: 20,
            background: "var(--color-surface)",
          }}
        >
          <ExternalWalletVerify
            onLinked={finish}
            onCancel={hasCircleWallet ? undefined : () => setMode("create")}
            cancelLabel="Create one instead"
          />
        </div>
      ) : (
        <>
          <div style={{ border: "2px solid var(--color-divider)", background: "var(--color-surface)" }}>
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="flex flex-wrap items-center gap-3">
                <span style={SQUARE} />
                <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 14.5 }}>
                  Circle user-controlled wallet
                </span>
                <span className="tag tag-outline" style={{ marginLeft: "auto" }}>
                  Non-custodial
                </span>
              </div>
              <p className="m-0" style={{ fontSize: 12.5, color: "var(--color-neutral-800)", lineHeight: 1.6 }}>
                Circle opens its own secure window and asks you to set a PIN. The signing key is split
                into shards that no single party ever holds — not Circle, and not Sweep Console. Nothing
                is written down, downloaded, or stored by you.
              </p>
            </div>

            <div
              style={{
                borderTop: "1px solid var(--color-divider)",
                padding: "16px 20px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <p
                className="m-0 uppercase"
                style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--color-neutral-600)" }}
              >
                What happens next
              </p>
              <ol
                className="m-0"
                // Preflight resets list-style, so the ordinals need asking for.
                style={{
                  paddingLeft: 18,
                  listStyle: "decimal",
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  color: "var(--color-neutral-800)",
                }}
              >
                <li>Circle&apos;s window opens — set a PIN and answer the recovery questions.</li>
                <li>The wallet is created and its address becomes your payout address.</li>
                <li>Withdraw whenever you like from Payments; your PIN authorises each transfer.</li>
              </ol>

              <div className="flex flex-wrap items-center gap-3" style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ padding: "11px 18px" }}
                  onClick={createCircleWallet}
                  disabled={busy}
                >
                  {phase === "opening" && "Opening Circle…"}
                  {phase === "waiting" && "Waiting for Circle…"}
                  {phase === "idle" && "Create wallet & continue"}
                </button>
                {busy && (
                  <span style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>
                    Finish the steps in the Circle window.
                  </span>
                )}
              </div>
            </div>
          </div>

          <p
            className="m-0"
            style={{ margin: "14px 0 0", fontSize: 12, color: "var(--color-neutral-700)", lineHeight: 1.6, maxWidth: "52ch" }}
          >
            A created wallet is yours, not ours — the same non-custodial guarantee as a wallet you
            bring. You can switch to an address you hold yourself at any time in Settings.
          </p>
        </>
      )}

      <div
        style={{
          marginTop: 18,
          borderTop: "1px solid var(--color-divider)",
          paddingTop: 16,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 18,
        }}
      >
        <div>
          <p
            className="m-0 uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--color-neutral-600)", marginBottom: 8 }}
          >
            Settles on
          </p>
          <div className="flex items-center gap-2.5">
            <ArcMark height={20} />
            <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 14.5 }}>Arc</span>
            <span className="tag tag-neutral">Fixed</span>
          </div>
        </div>
        <div>
          <p
            className="m-0 uppercase"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--color-neutral-600)", marginBottom: 8 }}
          >
            Subscribers can pay from
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5"><ArcMark height={14} /><span style={{ fontSize: 12.5 }}>Arc</span></span>
            <span className="flex items-center gap-1.5"><BaseMark height={14} /><span style={{ fontSize: 12.5 }}>Base</span></span>
            <span className="flex items-center gap-1.5"><ArbitrumMark height={14} /><span style={{ fontSize: 12.5 }}>Arbitrum</span></span>
            <span className="flex items-center gap-1.5"><OptimismMark height={14} /><span style={{ fontSize: 12.5 }}>Optimism</span></span>
          </div>
        </div>
      </div>
    </div>
  );
}
