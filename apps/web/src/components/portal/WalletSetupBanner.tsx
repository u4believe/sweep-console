import { useState } from "react";
import { ExternalWalletVerify } from "./ExternalWalletVerify";

interface Props {
  hasCircleWallet: boolean;
}

type Mode =
  | "select"
  | "circle-confirm"
  | "circle-loading"
  | "circle-waiting"
  | "external"
  | "success";

export function WalletSetupBanner({ hasCircleWallet }: Props) {
  const [mode, setMode] = useState<Mode>("select");
  const [error, setError] = useState("");

  function reset() {
    setMode("select");
    setError("");
  }

  async function startCircleWallet() {
    setMode("circle-loading");
    setError("");

    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
      const res = await fetch(`${apiUrl}/portal/wallet/circle`, { method: "POST", credentials: "include" });
      let data: Record<string, unknown> = {};
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok) throw new Error((data.error as { message?: string } | undefined)?.message ?? "Failed to start wallet creation");

      const payload = data as {
        userToken?: string;
        encryptionKey?: string;
        challengeId?: string;
        appId?: string;
        walletAddress?: string;
        alreadySetup?: boolean;
      };

      // Wallet already existed in Circle — saved directly, no SDK challenge needed
      if (payload.alreadySetup) {
        setMode("success");
        setTimeout(() => window.location.reload(), 1500);
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
      // Use VITE_CIRCLE_APP_ID if set (Vite env), otherwise fall back to API-returned appId
      const effectiveAppId = import.meta.env.VITE_CIRCLE_APP_ID ?? appId;
      sdk.setAppSettings({ appId: effectiveAppId });
      sdk.setAuthentication({ userToken, encryptionKey });

      setMode("circle-waiting");

      sdk.execute(challengeId, async (err) => {
        if (err) {
          setError(`Wallet setup failed: ${err.message ?? "Unknown error"}`);
          setMode("circle-confirm");
          return;
        }

        try {
          const apiUrl2 = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
          const confirmRes = await fetch(`${apiUrl2}/portal/wallet/circle/confirm`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ challengeId }),
            signal: AbortSignal.timeout(30_000),
          });
          const confirmData = await confirmRes.json() as { error?: { message?: string } };
          if (!confirmRes.ok) throw new Error(confirmData.error?.message ?? "Failed to save wallet");
          setMode("success");
          setTimeout(() => window.location.reload(), 1500);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed to save wallet. Please try again.");
          setMode("circle-confirm");
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setMode("select");
    }
  }

  if (mode === "success") {
    return (
      <div className="mb-6 rounded-xl border border-green-200 bg-green-50 p-6 text-center">
        <p className="font-semibold text-green-800">Wallet linked — loading your dashboard…</p>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-xl border-2 border-blue-200 bg-blue-50 p-6">
      <h2 className="mb-1 text-lg font-semibold text-gray-900">Set up your payout wallet</h2>
      <p className="mb-5 text-sm text-gray-600">
        Your wallet receives USDC after every subscription payment. Set it up before going live.
      </p>

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>
      )}

      {/* ── Option select ── */}
      {mode === "select" && (
        <div className="grid gap-3 sm:grid-cols-2">
          {!hasCircleWallet && (
            <button
              onClick={() => setMode("circle-confirm")}
              className="flex flex-col gap-1 rounded-xl border-2 border-blue-300 bg-white p-4 text-left hover:border-blue-500 hover:bg-blue-50 transition"
            >
              <span className="text-sm font-semibold text-gray-900">Create a wallet</span>
              <span className="text-xs text-gray-500">
                We&apos;ll create a secure Circle wallet for you — no setup needed.
              </span>
            </button>
          )}
          <button
            onClick={() => setMode("external")}
            className="flex flex-col gap-1 rounded-xl border-2 border-gray-200 bg-white p-4 text-left hover:border-gray-400 hover:bg-gray-50 transition"
          >
            <span className="text-sm font-semibold text-gray-900">
              {hasCircleWallet ? "Connect a wallet address" : "I already have a wallet"}
            </span>
            <span className="text-xs text-gray-500">
              Connect your wallet and sign a free message to verify ownership
            </span>
          </button>
        </div>
      )}

      {/* ── Circle wallet creation confirm ── */}
      {mode === "circle-confirm" && (
        <div className="space-y-4">
          <div className="rounded-lg bg-white border border-blue-200 p-4 text-sm text-gray-700 space-y-1">
            <p className="font-medium text-gray-900">How it works</p>
            <p>Circle opens a secure window where you set a PIN to protect your wallet.</p>
            <p>Your wallet address is automatically saved once complete.</p>
            <p className="text-xs text-gray-500 pt-1">This creates a one-time wallet — you won&apos;t need to do this again.</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={startCircleWallet}
              className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition"
            >
              Create my wallet
            </button>
            <button
              onClick={reset}
              className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {/* ── Circle SDK loading / waiting ── */}
      {(mode === "circle-loading" || mode === "circle-waiting") && (
        <div className="flex items-center gap-3 text-sm text-blue-700">
          <svg className="h-5 w-5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {mode === "circle-loading" ? "Opening Circle…" : "Waiting for Circle wallet setup to complete…"}
        </div>
      )}

      {/* ── External wallet: connect + sign-nonce ownership verification ── */}
      {mode === "external" && (
        <ExternalWalletVerify
          requirePassword={false}
          onLinked={() => {
            setMode("success");
            setTimeout(() => window.location.reload(), 1000);
          }}
          onCancel={reset}
        />
      )}
    </div>
  );
}
