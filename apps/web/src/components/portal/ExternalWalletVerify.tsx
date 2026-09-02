import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";

// External payout addresses (merchant path B) must be ownership-verified before
// the contract will ever push funds to them: connect the wallet, sign the
// server-issued nonce (personal_sign, gas-free), and the server checks the
// signature before activating the address.

interface Props {
  onLinked: (address: string) => void;
  /** Omit to render no cancel affordance at all. */
  onCancel?: () => void;
  cancelLabel?: string;
}

type Step = "idle" | "requesting" | "signing" | "verifying";

export function ExternalWalletVerify({
  onLinked,
  onCancel,
  cancelLabel = "Cancel",
}: Props) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [error, setError] = useState("");
  const [step, setStep] = useState<Step>("idle");

  const busy = step !== "idle";

  async function verify(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!address) return;
    setError("");

    try {
      // Both halves are guarded. Ownership of the account used to be proven
      // with the login password, which Google-only accounts (passwordHash:
      // null) could never supply; apiFetch now raises the step-up prompt
      // instead, and replays the call with the proof.
      setStep("requesting");
      const startRes = await apiFetch(`/portal/wallet/external`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address }),
      });
      if (!startRes.ok) {
        if (await wasCancelled(startRes)) { setStep("idle"); return; }
        throw new Error(await messageOf(startRes, "Failed to start verification"));
      }
      const startData = await startRes.json();

      setStep("signing");
      const signature = await signMessageAsync({ message: startData.message as string });

      setStep("verifying");
      const verifyRes = await apiFetch(`/portal/wallet/external/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature }),
      });
      if (!verifyRes.ok) {
        if (await wasCancelled(verifyRes)) { setStep("idle"); return; }
        throw new Error(await messageOf(verifyRes, "Signature verification failed"));
      }
      const verifyData = await verifyRes.json();

      onLinked(verifyData.walletAddress as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setStep("idle");
    }
  }

  return (
    <form onSubmit={verify} className="flex flex-col gap-3.5">
      {error && (
        <p className="m-0" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{error}</p>
      )}

      {!isConnected ? (
        <>
          <p className="m-0" style={{ fontSize: 12.5, color: "var(--color-neutral-800)", lineHeight: 1.6 }}>
            Connect the wallet you want to receive USDC payouts with. You&apos;ll sign a free
            message to prove you control it — no transaction, no gas.
          </p>
          <div className="self-start">
            <ConnectButton label="Connect payout wallet" />
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span style={{ width: 10, height: 10, background: "var(--color-accent)", display: "block" }} />
            <span
              style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, wordBreak: "break-all" }}
            >
              {address}
            </span>
            <span className="tag tag-neutral" style={{ marginLeft: "auto" }}>External wallet</span>
          </div>

          <p className="m-0" style={{ fontSize: 12.5, color: "var(--color-neutral-800)", lineHeight: 1.6 }}>
            Sign a message to prove you control this address. Settlements go straight here —
            Sweep Console never holds your balance.
          </p>

        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {isConnected && (
          <button
            type="submit"
            className="btn btn-primary"
            style={{ padding: "11px 18px" }}
            disabled={busy}
          >
            {step === "requesting" && "Preparing message…"}
            {step === "signing" && "Sign in your wallet…"}
            {step === "verifying" && "Verifying signature…"}
            {step === "idle" && "Sign to verify"}
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ color: "var(--color-neutral-700)" }}
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
        )}
      </div>
    </form>
  );
}
