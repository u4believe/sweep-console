"use client";

import { useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatUnits } from "viem";
import { ERC20_ABI, SUBSCRIPTION_MANAGER_ABI } from "@/lib/chain/abis";
import { ids } from "@/lib/ids";
import { clsx } from "clsx";

interface Plan {
  name: string;
  description: string;
  amount: number; // USDC smallest unit
  currency: string;
  interval: string;
  trialDays: number;
}

interface Props {
  sessionId: string;
  sessionToken: string;
  plan: Plan;
  merchant: { name: string };
  isTestMode: boolean;
  cancelUrl: string;
}

type Step = "connect" | "approve" | "subscribe" | "pending" | "success" | "error";

const INTERVAL_LABELS: Record<string, string> = {
  daily: "/ day",
  weekly: "/ week",
  monthly: "/ month",
  yearly: "/ year",
};

const INTERVAL_SECONDS: Record<string, number> = {
  daily: 86400,
  weekly: 604800,
  monthly: 2592000,
  yearly: 31536000,
};

export function CheckoutShell({ sessionId, plan, merchant, isTestMode, cancelUrl }: Props) {
  const { address, isConnected } = useAccount();
  const [step, setStep] = useState<Step>("connect");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [errorMsg, setErrorMsg] = useState("");

  const contractAddress = (
    isTestMode
      ? process.env.NEXT_PUBLIC_SUBSCRIPTION_CONTRACT_TESTNET
      : process.env.NEXT_PUBLIC_SUBSCRIPTION_CONTRACT_MAINNET
  ) as `0x${string}` | undefined;

  const usdcAddress = (
    isTestMode
      ? process.env.NEXT_PUBLIC_USDC_ADDRESS_TESTNET
      : process.env.NEXT_PUBLIC_USDC_ADDRESS_MAINNET
  ) as `0x${string}` | undefined;

  // Read subscriber's USDC balance
  const { data: usdcBalance } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!usdcAddress },
  });

  // Read current allowance
  const { data: currentAllowance } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address && contractAddress ? [address, contractAddress] : undefined,
    query: { enabled: !!address && !!usdcAddress && !!contractAddress },
  });

  const { writeContractAsync } = useWriteContract();

  const { isLoading: isTxPending } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });

  const planAmount = BigInt(plan.amount);
  const yearlyAllowance = planAmount * 12n;
  const formattedAmount = formatUnits(planAmount, 6);
  const formattedBalance = usdcBalance ? formatUnits(usdcBalance, 6) : "...";
  const hasEnoughBalance = usdcBalance !== undefined && usdcBalance >= planAmount;
  const alreadyApproved = currentAllowance !== undefined && currentAllowance >= yearlyAllowance;

  const onPay = async () => {
    if (!address || !contractAddress || !usdcAddress) return;

    try {
      if (!alreadyApproved) {
        setStep("approve");
        const approveTx = await writeContractAsync({
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [contractAddress, yearlyAllowance],
        });
        setTxHash(approveTx);
        // Wait for approval to mine
        await new Promise((r) => setTimeout(r, 2000));
      }

      setStep("subscribe");
      const onChainSubId = ids.toBytes32(sessionId);
      const trialSeconds = BigInt(plan.trialDays * 86400);
      const intervalSeconds = BigInt(INTERVAL_SECONDS[plan.interval] ?? 2592000);

      const subscribeTx = await writeContractAsync({
        address: contractAddress,
        abi: SUBSCRIPTION_MANAGER_ABI,
        functionName: "subscribe",
        args: [
          onChainSubId,
          contractAddress, // merchant wallet — fetched from API in production
          planAmount,
          intervalSeconds,
          trialSeconds,
        ],
      });

      setTxHash(subscribeTx);
      setStep("pending");

      // Notify the backend to activate the subscription and fire webhooks
      await fetch(`/api/internal/checkout/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          tx_hash: subscribeTx,
          wallet_address: address,
        }),
      });

      setStep("success");
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Transaction failed");
      setStep("error");
    }
  };

  if (step === "success") {
    return (
      <div className="card w-full max-w-md p-8 text-center">
        <div className="mb-4 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-100">
            <span className="text-3xl text-brand-600">&#10003;</span>
          </div>
        </div>
        <h2 className="mb-2 text-2xl font-bold">You&apos;re subscribed!</h2>
        <p className="mb-4 text-gray-500">
          {plan.trialDays > 0
            ? `Your ${plan.trialDays}-day free trial has started.`
            : `${plan.name} is now active.`}
        </p>
        {txHash && (
          <p className="font-mono text-xs text-gray-400">
            tx: {txHash.slice(0, 10)}...{txHash.slice(-8)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="card w-full max-w-md overflow-hidden">
      {/* Header */}
      <div className="border-b border-gray-100 bg-gradient-to-r from-brand-600 to-brand-700 px-6 py-5 text-white">
        <p className="text-sm font-medium opacity-80">{merchant.name}</p>
        <h1 className="mt-0.5 text-2xl font-bold">{plan.name}</h1>
        {plan.description && <p className="mt-1 text-sm opacity-75">{plan.description}</p>}
      </div>

      <div className="p-6">
        {/* Pricing */}
        <div className="mb-6 rounded-xl bg-gray-50 px-5 py-4">
          <div className="flex items-baseline gap-1">
            {plan.trialDays > 0 ? (
              <>
                <span className="text-3xl font-bold text-gray-900">Free</span>
                <span className="text-gray-500">for {plan.trialDays} days</span>
              </>
            ) : (
              <>
                <span className="text-3xl font-bold text-gray-900">${formattedAmount}</span>
                <span className="text-gray-500">{INTERVAL_LABELS[plan.interval] ?? ""}</span>
                <span className="ml-1 text-sm text-gray-400">{plan.currency}</span>
              </>
            )}
          </div>
          {plan.trialDays > 0 && (
            <p className="mt-1 text-sm text-gray-500">
              Then ${formattedAmount} {plan.currency} {INTERVAL_LABELS[plan.interval]}
            </p>
          )}
        </div>

        {/* Wallet connection */}
        {!isConnected ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Connect your wallet to pay with USDC.</p>
            <ConnectButton label="Connect Wallet" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Balance */}
            <div className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
              <span className="text-sm text-gray-600">USDC Balance</span>
              <span
                className={clsx(
                  "font-semibold tabular-nums",
                  hasEnoughBalance ? "text-gray-900" : "text-red-600"
                )}
              >
                ${formattedBalance}
              </span>
            </div>

            {!hasEnoughBalance && (
              <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
                Insufficient USDC balance. You need at least ${formattedAmount} USDC.
              </p>
            )}

            {step === "error" && (
              <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{errorMsg}</p>
            )}

            {/* Pay button */}
            <button
              onClick={onPay}
              disabled={!hasEnoughBalance || step === "pending" || isTxPending}
              className="btn-primary w-full py-4 text-base"
            >
              {step === "approve" && "Approving USDC..."}
              {step === "subscribe" && "Confirming subscription..."}
              {step === "pending" && "Waiting for block..."}
              {(step === "connect" || step === "error") && (
                <>
                  {plan.trialDays > 0
                    ? `Start ${plan.trialDays}-day free trial`
                    : `Confirm & Pay $${formattedAmount} USDC`}
                </>
              )}
            </button>

            {/* Status indicator */}
            {(step === "approve" || step === "subscribe" || step === "pending") && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <div className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
                <span>
                  {step === "approve" && "Step 1/2: Approve USDC allowance in your wallet"}
                  {step === "subscribe" && "Step 2/2: Confirm subscription transaction"}
                  {step === "pending" && "Transaction submitted — waiting for confirmation on Arc"}
                </span>
              </div>
            )}

            <button
              onClick={() => window.location.assign(cancelUrl)}
              className="w-full text-center text-sm text-gray-400 hover:text-gray-600"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Security note */}
        <p className="mt-6 text-center text-xs text-gray-400">
          Secured by Arc blockchain &middot; USDC settlement &middot; Sub-second finality
        </p>
      </div>

      {isTestMode && (
        <div className="border-t border-yellow-200 bg-yellow-50 px-6 py-3 text-center text-xs font-medium text-yellow-700">
          TEST MODE — No real USDC is charged
        </div>
      )}
    </div>
  );
}
