import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

// External payout addresses (merchant path B) must be ownership-verified before
// the contract will ever push funds to them: connect the wallet, sign the
// server-issued nonce (personal_sign, gas-free), and the server checks the
// signature before activating the address.

interface Props {
  // Changing an already-linked payout address requires the account password
  requirePassword: boolean;
  onLinked: (address: string) => void;
  onCancel: () => void;
}

type Step = "idle" | "requesting" | "signing" | "verifying";

export function ExternalWalletVerify({ requirePassword, onLinked, onCancel }: Props) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState<Step>("idle");

  const busy = step !== "idle";

  async function verify(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!address) return;
    setError("");

    try {
      setStep("requesting");
      const startRes = await fetch(`${API_URL}/portal/wallet/external`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: address,
          ...(requirePassword ? { password } : {}),
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) {
        throw new Error(startData.error?.message ?? "Failed to start verification");
      }

      setStep("signing");
      const signature = await signMessageAsync({ message: startData.message as string });

      setStep("verifying");
      const verifyRes = await fetch(`${API_URL}/portal/wallet/external/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok) {
        throw new Error(verifyData.error?.message ?? "Signature verification failed");
      }

      onLinked(verifyData.walletAddress as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setStep("idle");
    }
  }

  return (
    <form onSubmit={verify} className="space-y-4">
      {error && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>
      )}

      {!isConnected ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Connect the wallet you want to receive USDC payouts with. You&apos;ll sign a
            free message to prove you control it — no transaction, no gas.
          </p>
          <ConnectButton label="Connect payout wallet" />
        </div>
      ) : (
        <>
          <div className="rounded-lg bg-gray-50 px-4 py-3">
            <p className="mb-0.5 text-xs font-medium text-gray-500">Connected wallet</p>
            <code className="break-all font-mono text-sm text-gray-800">{address}</code>
          </div>

          {requirePassword && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Account password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                Changing your payout address requires your password.
              </p>
            </div>
          )}
        </>
      )}

      <div className="flex flex-wrap gap-3">
        {isConnected && (
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {step === "requesting" && "Preparing message…"}
            {step === "signing" && "Sign in your wallet…"}
            {step === "verifying" && "Verifying signature…"}
            {step === "idle" && "Sign & verify ownership"}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
