import { useEffect, useRef, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  useChainId,
  useConfig,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useReconnect,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { getChainId } from "wagmi/actions";
import { formatUnits } from "viem";
import { clsx } from "clsx";
import { ERC20_ABI, SUBSCRIPTION_MANAGER_ABI } from "@/lib/chain/abis";
import { arcTestnet } from "@/lib/chain/config";
import { GatewaySweepPanel } from "./GatewaySweepPanel";
import { DelegatedRenewalToggle } from "./DelegatedRenewalToggle";
import { ManageSubscriptionsPanel } from "./ManageSubscriptionsPanel";
import { ArcLogo, BaseLogo, ArbitrumLogo, OptimismLogo } from "./ChainBadge";
import { Turnstile, TURNSTILE_ENABLED } from "@/components/Turnstile";
import {
  fetchWalletStatus,
  hydrateTypedData,
  requestOtp,
  verifyOtp,
  type TypedDataPayload,
} from "@/lib/gateway";

// Checkout is gasless by default: the subscriber signs ONE EIP-2612 permit
// (grants a year of renewals) and the platform submits subscribeWithPermit()
// on Arc, paying the gas. If that fails, the UI falls back to the direct path —
// two subscriber-submitted transactions: USDC.approve(amount × 12) + subscribe().
// Renewals always produce zero subscriber signatures.
const ALLOWANCE_PERIODS = 12n;
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Plan {
  name: string;
  description: string;
  amount: number; // USDC micro-units (6 decimals)
  currency: string;
  interval: string;
  trialDays: number;
  defaultTierName?: string | null;
  defaultFeatures?: string[] | null;
}

export interface OnChainParams {
  subId: `0x${string}`;
  managerAddress: `0x${string}`;
  usdcAddress: `0x${string}`;
  merchantPayout: `0x${string}`;
  planIdBytes32: `0x${string}`;
  amount: string; // per-period USDC micro-units, stringified bigint
  intervalSeconds: number;
  trialSeconds: number;
  settlementWindowSeconds: number;
}

export interface Tier {
  id: string;
  name: string;
  amount: number; // USDC micro-units
  interval: string;
  trialDays: number;
  features: string[] | null;
}

interface Props {
  sessionId: string;
  sessionToken: string;
  plan: Plan;
  tiers: Tier[];
  merchant: { name: string };
  isTestMode: boolean;
  cancelUrl: string;
  onchain: OnChainParams;
}

type Step = "idle" | "approving" | "subscribing" | "confirming" | "success" | "error";

const INTERVAL_SECONDS: Record<string, number> = {
  daily: 86_400,
  weekly: 604_800,
  monthly: 2_592_000,
  yearly: 31_536_000,
};

const INTERVAL_LABELS: Record<string, string> = {
  daily: "/ day",
  weekly: "/ week",
  monthly: "/ month",
  yearly: "/ year",
};

export function CheckoutShell({ sessionId, sessionToken, plan, tiers, merchant, isTestMode, cancelUrl, onchain }: Props) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();
  const { reconnect } = useReconnect();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const wagmiConf = useConfig();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  // Ensure the wallet is on Arc and WAIT for the connector to report it — the
  // gasless permit is an Arc-domain EIP-712 payload, so signing it while the
  // wallet is still on another chain throws a chainId-mismatch.
  const ensureArc = async () => {
    if (getChainId(wagmiConf) === arcTestnet.id) return;
    await switchChainAsync({ chainId: arcTestnet.id });
    for (let i = 0; i < 40; i++) {
      if (getChainId(wagmiConf) === arcTestnet.id) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const [step, setStep] = useState<Step>("idle");
  const [txHashDisplay, setTxHashDisplay] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState("");
  const [showSweep, setShowSweep] = useState(false);
  const [email, setEmail] = useState("");
  const [showDirectFallback, setShowDirectFallback] = useState(false);
  // Email is the identity anchor (per merchant); the wallet is the payment method
  // attached to it. Entering a known email recalls the returning customer and the
  // wallet they last paid with here.
  const [recalledWallet, setRecalledWallet] = useState<string | null>(null);

  // Email verification (OTP). A subscriber must be a verified customer of this
  // merchant before any activation: a returning wallet is recognized (walletVerified);
  // a new wallet/email proves ownership via a 6-digit code → emailToken.
  const [walletVerified, setWalletVerified] = useState(false);
  const [recognizedEmail, setRecognizedEmail] = useState<string | null>(null);
  const [emailToken, setEmailToken] = useState<string | null>(null);
  const [otpPhase, setOtpPhase] = useState<"idle" | "sending" | "sent" | "verifying">("idle");
  const [otpCode, setOtpCode] = useState("");
  const [otpError, setOtpError] = useState("");
  const [otpCaptcha, setOtpCaptcha] = useState("");
  const [otpCaptchaReset, setOtpCaptchaReset] = useState(0);
  const verified = walletVerified || !!emailToken;

  const emailValid = EMAIL_RE.test(email.trim());

  // Returning customer = a known email with a wallet on file for this merchant.
  const isReturning = !!recalledWallet;
  const shortAddr = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const onConnect = () => openConnectModal?.();
  const onUseDifferentWallet = () => {
    disconnect();
    setTimeout(() => openConnectModal?.(), 200);
  };

  // Wallets never auto-connect (see WagmiProvider reconnectOnMount=false). The
  // ONE exception: a returning, email-verified customer — silently restore the
  // wallet they used here before so they land straight on the payment options.
  const reconnectTried = useRef(false);
  useEffect(() => {
    if (verified && isReturning && !isConnected && !reconnectTried.current) {
      reconnectTried.current = true;
      reconnect();
    }
  }, [verified, isReturning, isConnected, reconnect]);

  // Email-anchored recall: when a known email is entered, recognise the returning
  // customer (and the wallet on file) for THIS merchant.
  useEffect(() => {
    const e = email.trim();
    if (!EMAIL_RE.test(e)) { setRecalledWallet(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`${API_URL}/customer/recall?email=${encodeURIComponent(e)}&session_id=${sessionId}`)
        .then((r) => r.json())
        .then((data: { known?: boolean; wallet_masked?: string | null }) => {
          if (!cancelled) setRecalledWallet(data.known ? (data.wallet_masked ?? null) : null);
        })
        .catch(() => { if (!cancelled) setRecalledWallet(null); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [email, sessionId]);

  // Wallet recognition: is THIS connected wallet already an OTP-verified customer
  // of this merchant? If so, the OTP step is skipped (it's already linked).
  useEffect(() => {
    if (!address) { setWalletVerified(false); setRecognizedEmail(null); return; }
    let cancelled = false;
    fetchWalletStatus(sessionId, address)
      .then((s) => {
        if (cancelled) return;
        setWalletVerified(s.linked && s.verified);
        setRecognizedEmail(s.email_masked);
      })
      .catch(() => { if (!cancelled) { setWalletVerified(false); setRecognizedEmail(null); } });
    return () => { cancelled = true; };
  }, [address, sessionId]);

  // A verification token is bound to the email it was issued for — drop it (and
  // reset the OTP UI) whenever the email changes.
  useEffect(() => {
    setEmailToken(null);
    setOtpPhase("idle");
    setOtpCode("");
    setOtpError("");
  }, [email]);

  const onSendCode = async () => {
    if (!emailValid) { setOtpError("Enter a valid email first."); return; }
    if (TURNSTILE_ENABLED && !otpCaptcha) { setOtpError("Complete the captcha first."); return; }
    setOtpError(""); setOtpPhase("sending");
    try {
      await requestOtp(sessionId, email.trim(), otpCaptcha);
      setOtpPhase("sent");
    } catch (e) {
      setOtpError(e instanceof Error ? e.message : "Could not send the code.");
      setOtpPhase("idle");
    } finally {
      // The token is single-use — mint a fresh one so "Resend" works.
      setOtpCaptchaReset((n) => n + 1);
    }
  };

  const onVerifyCode = async () => {
    if (!/^\d{6}$/.test(otpCode.trim())) { setOtpError("Enter the 6-digit code."); return; }
    setOtpError(""); setOtpPhase("verifying");
    try {
      const { email_token } = await verifyOtp(email.trim(), otpCode.trim());
      setEmailToken(email_token);
      setOtpPhase("sent");
    } catch (e) {
      setOtpError(e instanceof Error ? e.message : "Verification failed.");
      setOtpPhase("sent");
    }
  };

  // Chosen tier (null = the plan's default tier). The effective amount/interval/
  // trial drive the price display, the on-chain subscribe, the permit, and the
  // balance check. We mirror the choice to the server (PATCH /tier) before paying
  // so every backend charge path resolves the same tier.
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const selectedTier = selectedTierId ? tiers.find((t) => t.id === selectedTierId) ?? null : null;

  // Two-step checkout when there's more than one option: "plans" shows the
  // pricing table, "pay" shows the payment panel. Single-tier plans skip straight
  // to "pay".
  const [view, setView] = useState<"plans" | "pay">(tiers.length > 0 ? "plans" : "pay");
  const selectedTierName = selectedTier ? selectedTier.name : plan.defaultTierName || plan.name;

  // All choosable options as uniform pricing cards (default tier first).
  const tierOptions = [
    {
      id: null as string | null,
      name: plan.defaultTierName || plan.name,
      amount: Number(onchain.amount),
      interval: plan.interval,
      trialDays: plan.trialDays,
      features: plan.defaultFeatures ?? [],
    },
    ...tiers.map((t) => ({
      id: t.id,
      name: t.name,
      amount: t.amount,
      interval: t.interval,
      trialDays: t.trialDays,
      features: t.features ?? [],
    })),
  ];


  const planAmount = selectedTier ? BigInt(selectedTier.amount) : BigInt(onchain.amount);
  const effectiveIntervalSeconds = selectedTier
    ? INTERVAL_SECONDS[selectedTier.interval] ?? 2_592_000
    : onchain.intervalSeconds;
  const effectiveTrialSeconds = selectedTier ? selectedTier.trialDays * 86_400 : onchain.trialSeconds;
  const effectiveInterval = selectedTier ? selectedTier.interval : plan.interval;
  const effectiveTrialDays = selectedTier ? selectedTier.trialDays : plan.trialDays;
  const formattedAmount = formatUnits(planAmount, 6);
  const hasTrial = effectiveTrialDays > 0;

  // Persist the chosen tier on the session so the backend resolves the same terms.
  const syncTier = async () => {
    await fetch(`${API_URL}/checkout/${sessionId}/tier`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_token: sessionToken, tier_id: selectedTierId }),
    }).catch(() => { /* non-fatal; the server falls back to the default tier */ });
  };

  const { data: usdcBalance } = useReadContract({
    address: onchain.usdcAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: !!address },
  });

  const hasEnoughBalance =
    hasTrial || (usdcBalance !== undefined && (usdcBalance as bigint) >= planAmount);

  // Gasless primary path — one EIP-2612 permit signature; the platform submits
  // subscribeWithPermit() on Arc and pays the gas.
  const onPayGasless = async () => {
    if (!address) return;
    if (!verified) { setErrorMsg("Verify your email to continue."); return; }
    setErrorMsg("");

    try {
      setStep("approving"); // "Authorizing…" — single off-chain signature

      // Mirror the chosen tier to the server, then ensure we're on Arc to sign.
      await syncTier();
      await ensureArc();

      const permitRes = await fetch(`${API_URL}/internal/checkout/${sessionId}/permit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet_address: address }),
      });
      if (!permitRes.ok) throw new Error("Could not prepare the permit");
      const permit = (await permitRes.json()) as {
        permit_payload: TypedDataPayload;
        permit_value: string;
        permit_deadline: string;
      };

      const signature = await signTypedDataAsync(hydrateTypedData(permit.permit_payload) as never);

      setStep("confirming");
      const res = await fetch(`${API_URL}/internal/checkout/gasless`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          wallet_address: address,
          email: email.trim(),
          email_token: emailToken,
          permit_signature: signature,
          permit_value: permit.permit_value,
          permit_deadline: permit.permit_deadline,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Offer the direct (gas-paying) path as a fallback
        setShowDirectFallback(true);
        throw new Error(
          (data as { error?: { message?: string } }).error?.message ?? "Gasless activation failed"
        );
      }

      setStep("success");
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Transaction failed");
      setStep("error");
    }
  };

  // Direct fallback — two subscriber-submitted transactions (approve + subscribe).
  // The subscriber pays Arc gas. Used only if the gasless path fails.
  const onPayDirect = async () => {
    if (!address || !publicClient) return;
    if (!verified) { setErrorMsg("Verify your email to continue."); return; }
    setErrorMsg("");

    try {
      await syncTier();
      if (chainId !== arcTestnet.id) {
        await switchChainAsync({ chainId: arcTestnet.id });
      }

      const allowanceTarget = planAmount * ALLOWANCE_PERIODS;

      // Tx 1/2 — grant the year-long USDC allowance. Skipped when a previous
      // attempt already granted enough (makes retries idempotent).
      let approveTxHash: `0x${string}` | undefined;
      const currentAllowance = (await publicClient.readContract({
        address: onchain.usdcAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, onchain.managerAddress],
      })) as bigint;

      if (currentAllowance < allowanceTarget) {
        setStep("approving");
        approveTxHash = await writeContractAsync({
          chainId: arcTestnet.id,
          address: onchain.usdcAddress,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [onchain.managerAddress, allowanceTarget],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
      }

      // Tx 2/2 — subscribe(). Pulls the first period into the contract's
      // settlement-window escrow (or starts the trial with no payment).
      // Skipped when a previous attempt already registered this subscription.
      setStep("subscribing");
      let subscribeTxHash: `0x${string}` | undefined;
      let blockNumber: number | undefined;

      const existing = await publicClient.readContract({
        address: onchain.managerAddress,
        abi: SUBSCRIPTION_MANAGER_ABI,
        functionName: "getSubscription",
        args: [onchain.subId],
      });

      if (existing.status === 0) {
        subscribeTxHash = await writeContractAsync({
          chainId: arcTestnet.id,
          address: onchain.managerAddress,
          abi: SUBSCRIPTION_MANAGER_ABI,
          functionName: "subscribe",
          args: [
            onchain.subId,
            onchain.merchantPayout,
            onchain.planIdBytes32,
            planAmount,
            BigInt(effectiveIntervalSeconds),
            BigInt(effectiveTrialSeconds),
            BigInt(onchain.settlementWindowSeconds),
          ],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: subscribeTxHash });
        blockNumber = Number(receipt.blockNumber);
        setTxHashDisplay(subscribeTxHash);
      } else if (existing.subscriber.toLowerCase() !== address.toLowerCase()) {
        throw new Error("This checkout session was already used by another wallet.");
      }

      // Notify the backend — it re-verifies the subscription on-chain before
      // recording it and firing merchant webhooks.
      setStep("confirming");
      const res = await fetch(`${API_URL}/internal/checkout/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          tx_hash: subscribeTxHash,
          allowance_tx_hash: approveTxHash,
          wallet_address: address,
          email: email.trim(),
          email_token: emailToken,
          block_number: blockNumber,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: { message?: string } }).error?.message ?? "Failed to activate subscription"
        );
      }

      setStep("success");
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Transaction failed");
      setStep("error");
    }
  };

  if (step === "success") {
    return (
      <div className="card mx-auto w-full max-w-md p-8">
        <div className="text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-100">
              <span className="text-3xl text-brand-600">&#10003;</span>
            </div>
          </div>
          <h2 className="mb-2 text-2xl font-bold">You&apos;re subscribed!</h2>
          <p className="text-gray-500">
            {hasTrial
              ? `Your ${effectiveTrialDays}-day free trial has started.`
              : `${plan.name} is now active.`}
          </p>
          {txHashDisplay && (
            <p className="mt-3 break-all font-mono text-xs text-gray-400">
              tx: {txHashDisplay.slice(0, 10)}...{txHashDisplay.slice(-8)}
            </p>
          )}
        </div>

        {/* Optional next step — enable cross-chain renewals now, so a future
            renewal can fall back to Base/Arbitrum/Optimism if your Arc balance
            runs dry. The grant links to the subscription you just created. The
            toggle self-hides if your wallet can't grant, or it's already enabled. */}
        {address && verified && (
          <div className="mt-6 text-left">
            <DelegatedRenewalToggle
              sessionId={sessionId}
              sessionToken={sessionToken}
              walletAddress={address}
              email={EMAIL_RE.test(email.trim()) ? email.trim() : undefined}
              emailToken={emailToken}
            />
          </div>
        )}

        {/* Standalone portal — view/cancel this and any other subscription later
            (opens in a new tab so this confirmation stays put). */}
        <p className="mt-6 text-center text-sm">
          <a href="/manage" target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:underline">
            Manage your subscriptions ↗
          </a>
        </p>
      </div>
    );
  }

  const isPending = step === "approving" || step === "subscribing" || step === "confirming";

  // ─── Step 1: pricing table (multi-tier plans) ──────────────────────────────
  if (view === "plans" && tierOptions.length > 1) {
    // One "recommended" tier gets the glow accent (mirrors the landing pricing).
    const recommendedIdx = tierOptions.length >= 3 ? Math.floor(tierOptions.length / 2) : tierOptions.length - 1;
    const recommendedId = tierOptions[recommendedIdx]?.id ?? null;
    // No persistent "filled" selection — choosing a plan carries you straight to
    // payment with that tier. Hovering a card is the "about to select" affordance.
    const choose = (id: string | null) => { setSelectedTierId(id); setView("pay"); };

    return (
      <div className="relative mx-auto w-full max-w-5xl">
        {/* ambient lighting (echoes the landing pricing section) */}
        <div className="pointer-events-none absolute left-1/2 top-0 h-64 w-[42rem] -translate-x-1/2 rounded-full bg-brand-200/40 blur-3xl" />

        <div className="relative mb-10 text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">{merchant.name}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">Choose your plan</h1>
          <p className="mx-auto mt-2 max-w-lg text-gray-500">
            {plan.description ? plan.description : plan.name}
          </p>
        </div>

        <div className="relative flex flex-wrap items-stretch justify-center gap-6">
          {tierOptions.map((t) => {
            const free = t.amount === 0;
            const recommended = t.id === recommendedId;
            const features = t.features.length ? t.features : ["Full access"];
            return (
              <div
                key={t.id ?? "default"}
                className={clsx(
                  "group relative flex w-full flex-col overflow-hidden rounded-3xl border bg-white p-7 transition-all duration-200 sm:w-72",
                  "hover:-translate-y-1 hover:border-brand-300 hover:shadow-xl hover:shadow-brand-500/10",
                  recommended ? "border-brand-200 shadow-lg shadow-brand-500/10" : "border-gray-200 shadow-sm"
                )}
              >
                {recommended && (
                  <div className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full bg-gradient-to-tr from-brand-400 via-brand-300 to-blue-200 opacity-40 blur-3xl transition-opacity duration-300 group-hover:opacity-60" />
                )}

                <div className="relative flex flex-1 flex-col">
                  {recommended && (
                    <span className="mb-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-brand-500" /> Recommended
                    </span>
                  )}

                  <h3 className="text-lg font-semibold text-gray-900">{t.name}</h3>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-4xl font-bold tracking-tight text-gray-900">
                      {free ? "Free" : `$${formatUnits(BigInt(t.amount), 6)}`}
                    </span>
                    {!free && <span className="text-sm text-gray-400">{INTERVAL_LABELS[t.interval] ?? ""}</span>}
                  </div>
                  {t.trialDays > 0 && (
                    <span className="mt-3 inline-block w-fit rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">
                      {t.trialDays}-day free trial
                    </span>
                  )}

                  <div className="my-5 h-px w-full bg-gray-100" />

                  <ul className="flex-1 space-y-2.5 text-sm">
                    {features.map((f, i) => (
                      <li key={i} className="flex items-start gap-2.5 text-gray-600">
                        <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                          <svg className="h-2.5 w-2.5" viewBox="0 0 20 20" fill="none"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>

                  <button
                    onClick={() => choose(t.id)}
                    className="mt-7 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-gray-900 py-2.5 text-sm font-semibold text-white transition hover:bg-black"
                  >
                    {free ? "Start free" : `Choose ${t.name}`}
                    <svg className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" viewBox="0 0 20 20" fill="none"><path d="M4 10h11M11 5l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <p className="relative mt-8 text-center text-xs text-gray-400">
          Pay with USDC on Arc · cancel anytime · {isTestMode ? "Test mode" : "Secured by Arc"}
        </p>
      </div>
    );
  }

  // ─── Step 2: payment details (two-panel) ───────────────────────────────────
  const merchantInitial = (merchant.name || "S").trim().charAt(0).toUpperCase();
  const previewFeatures = selectedTier?.features ?? plan.defaultFeatures ?? [];
  const openOtherChains = async () => {
    if (!verified) { setErrorMsg("Verify your email to continue."); return; }
    await syncTier();
    setShowSweep(true);
  };

  return (
    <div className="mx-auto w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-xl">
      <div className="grid md:grid-cols-[320px_1fr]">
        {/* ─── Left: preview — a mini plan card echoing the pricing page ──── */}
        <aside className="hidden flex-col gap-4 border-r border-gray-100 bg-gray-50/70 p-5 md:flex">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Your plan</p>

          <div className="relative overflow-hidden rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-tr from-brand-400 via-brand-300 to-blue-200 opacity-30 blur-3xl" />
            <div className="relative">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-bold text-white">
                  {merchantInitial}
                </div>
                <span className="truncate text-xs font-medium text-gray-500">{merchant.name}</span>
              </div>

              <h3 className="mt-4 text-lg font-semibold text-gray-900">{selectedTierName}</h3>
              <div className="mt-1 flex items-baseline gap-1">
                {hasTrial ? (
                  <>
                    <span className="text-3xl font-bold tracking-tight text-gray-900">Free</span>
                    <span className="text-sm text-gray-400">for {effectiveTrialDays} days</span>
                  </>
                ) : (
                  <>
                    <span className="text-3xl font-bold tracking-tight text-gray-900">${formattedAmount}</span>
                    <span className="text-sm text-gray-400">{INTERVAL_LABELS[effectiveInterval] ?? ""}</span>
                  </>
                )}
              </div>
              {hasTrial && (
                <p className="mt-1 text-xs text-gray-500">
                  then ${formattedAmount} {plan.currency} {INTERVAL_LABELS[effectiveInterval] ?? ""}
                </p>
              )}

              {previewFeatures.length > 0 && (
                <>
                  <div className="my-4 h-px w-full bg-gray-100" />
                  <ul className="space-y-2 text-xs">
                    {previewFeatures.slice(0, 5).map((f, i) => (
                      <li key={i} className="flex items-start gap-2 text-gray-600">
                        <span className="mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                          <svg className="h-2 w-2" viewBox="0 0 20 20" fill="none"><path d="M5 10.5l3.5 3.5L15 6.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>

          {plan.description && (
            <p className="text-xs leading-relaxed text-gray-500">{plan.description}</p>
          )}
        </aside>

        {/* ─── Right: payment details ────────────────────────────────────── */}
        <div className="p-5">
          <div className="flex items-start justify-between">
            <h1 className="text-xl font-bold text-gray-900">Payment details</h1>
            <button
              onClick={() => window.location.assign(cancelUrl)}
              aria-label="Cancel"
              className="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>
          </div>

          {/* Selected plan summary (multi-tier) */}
          {tiers.length > 0 && !isPending && (
            <div className="mt-4 flex items-center justify-between rounded-lg bg-gray-50 px-4 py-2.5">
              <span className="text-sm text-gray-600">
                Plan: <span className="font-medium text-gray-900">{selectedTierName}</span>
              </span>
              <button onClick={() => setView("plans")} className="text-xs font-medium text-brand-600 hover:underline">
                Change plan
              </button>
            </div>
          )}

          {showSweep && address ? (
            /* Cross-chain path: sweep USDC from Base / Arbitrum / Optimism */
            <div className="mt-4">
              <GatewaySweepPanel
                sessionId={sessionId}
                sessionToken={sessionToken}
                walletAddress={address}
                email={EMAIL_RE.test(email.trim()) ? email.trim() : undefined}
                emailToken={emailToken}
                onSuccess={(txHash) => {
                  if (txHash) setTxHashDisplay(txHash);
                  setStep("success");
                }}
                onClose={() => setShowSweep(false)}
              />
            </div>
          ) : !verified ? (
            /* ── Step 1: verify email FIRST (before any wallet connection) ── */
            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-gray-700">Email address</label>
              <p className="mb-2 text-xs text-gray-500">
                {isReturning
                  ? `Welcome back — you've paid here before with ${recalledWallet}. Verify your email to continue.`
                  : "Verify your email to continue — we'll send you a 6-digit code."}
              </p>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <button
                  onClick={onSendCode}
                  disabled={!emailValid || otpPhase === "sending" || (TURNSTILE_ENABLED && !otpCaptcha)}
                  className="whitespace-nowrap rounded-lg border border-brand-200 px-3 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50"
                >
                  {otpPhase === "sending" ? "Sending…" : otpPhase === "sent" || otpPhase === "verifying" ? "Resend" : "Send code"}
                </button>
              </div>

              {emailValid && (
                <Turnstile
                  onVerify={setOtpCaptcha}
                  onExpire={() => setOtpCaptcha("")}
                  resetSignal={otpCaptchaReset}
                  className="mt-2"
                />
              )}

              {(otpPhase === "sent" || otpPhase === "verifying") && (
                <div className="mt-2 flex gap-2">
                  <input
                    inputMode="numeric"
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="6-digit code"
                    className="w-32 rounded-lg border border-gray-200 px-3 py-2 text-sm tabular-nums focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <button
                    onClick={onVerifyCode}
                    disabled={otpCode.trim().length !== 6 || otpPhase === "verifying"}
                    className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {otpPhase === "verifying" ? "Verifying…" : "Verify"}
                  </button>
                </div>
              )}
              {otpError && <p className="mt-1 text-xs text-red-600">{otpError}</p>}
            </div>
          ) : (
            /* ── Step 2: email verified — connect wallet (intentional) then pay ── */
            <div className="mt-4 space-y-2.5">
              {/* Verified identity */}
              <div className="flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-brand-600 text-[10px] font-bold text-white">✓</span>
                Verified as {emailToken ? email.trim() : recognizedEmail ?? "your account"}
              </div>

              {!isConnected ? (
                /* Intentional connect — returning customers see their last wallet. */
                isReturning ? (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <p className="text-sm text-gray-600">You previously paid here with</p>
                    <p className="mt-0.5 font-mono text-sm font-semibold text-gray-900">{recalledWallet}</p>
                    <button
                      onClick={onConnect}
                      className="mt-3 w-full rounded-xl bg-gray-900 py-2.5 text-sm font-semibold text-white transition hover:bg-black"
                    >
                      Connect to continue
                    </button>
                    <button onClick={onConnect} className="mt-2 w-full text-center text-xs font-medium text-brand-600 hover:underline">
                      Use a different wallet
                    </button>
                  </div>
                ) : (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-center">
                    <p className="text-sm text-gray-600">Connect your wallet to pay with USDC.</p>
                    <button
                      onClick={onConnect}
                      className="mt-3 w-full rounded-xl bg-gray-900 py-2.5 text-sm font-semibold text-white transition hover:bg-black"
                    >
                      Connect Wallet
                    </button>
                  </div>
                )
              ) : (
                /* Connected — payment options */
                <>
                  {/* Connected wallet */}
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2">
                    <span className="flex items-center gap-2 truncate text-sm text-gray-700">
                      <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
                      <span className="font-mono">{shortAddr(address)}</span>
                    </span>
                    <button onClick={onUseDifferentWallet} className="shrink-0 text-xs font-medium text-brand-600 hover:underline">
                      Use a different wallet
                    </button>
                  </div>

                  {/* Summary */}
                  <div className="space-y-1.5 rounded-xl bg-gray-50 px-4 py-2.5 text-sm">
                    <div className="flex items-center justify-between text-gray-500">
                      <span>Subtotal</span>
                      <span className="text-gray-900">${formattedAmount} {plan.currency}</span>
                    </div>
                    <div className="flex items-center justify-between text-gray-500">
                      <span>Network fee</span>
                      <span className="font-medium text-brand-600">Free</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-gray-200 pt-2 text-base font-semibold text-gray-900">
                      <span>{hasTrial ? "Due today" : "Total"}</span>
                      <span>{hasTrial ? `$0.00 ${plan.currency}` : `$${formattedAmount} ${plan.currency}`}</span>
                    </div>
                    {hasTrial && (
                      <p className="text-xs text-gray-400">
                        Then ${formattedAmount} {plan.currency} {INTERVAL_LABELS[effectiveInterval] ?? ""} after your {effectiveTrialDays}-day trial.
                      </p>
                    )}
                  </div>

                  {step === "error" && (
                    <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{errorMsg}</p>
                  )}

                  {/* Pay with USDC on Arc — the Arc badge IS the clickable pay action.
                      It always shows, but is only clickable when there's enough Arc
                      liquidity; otherwise it's disabled and says why. */}
                  <button
                    onClick={showDirectFallback ? onPayDirect : onPayGasless}
                    disabled={!hasEnoughBalance || isPending}
                    className={clsx(
                      "flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition disabled:cursor-not-allowed",
                      hasEnoughBalance
                        ? "border-brand-500 bg-brand-50/60 hover:bg-brand-50 disabled:opacity-60"
                        : "border-gray-200 bg-gray-50"
                    )}
                  >
                    {isPending ? (
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center">
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
                      </span>
                    ) : (
                      <ArcLogo className={clsx("h-9 w-9 shrink-0", !hasEnoughBalance && "opacity-40 grayscale")} />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-gray-900">
                        {isPending
                          ? "Processing payment…"
                          : !hasEnoughBalance ? "USDC on Arc"
                          : hasTrial ? `Start ${effectiveTrialDays}-day free trial on Arc`
                          : "Pay with USDC on Arc"}
                      </span>
                      {!isPending && (
                        <span
                          className={clsx(
                            "block text-xs",
                            hasEnoughBalance ? "text-gray-500" : usdcBalance === undefined && !hasTrial ? "text-gray-400" : "text-red-500"
                          )}
                        >
                          {hasEnoughBalance
                            ? "Recommended · gasless · instant settlement"
                            : usdcBalance === undefined && !hasTrial
                              ? "Checking your Arc balance…"
                              : "Not enough USDC on Arc — top up, or pay from another chain below."}
                        </span>
                      )}
                    </span>
                    {!isPending && (
                      <span className="shrink-0 text-sm font-bold text-gray-900">{hasTrial ? "Free" : `$${formattedAmount}`}</span>
                    )}
                  </button>

                  {showDirectFallback && (step === "idle" || step === "error") && (
                    <p className="text-center text-xs text-gray-400">
                      Gasless wasn't available — you'll confirm two quick prompts in your wallet.
                    </p>
                  )}

                  {/* Pay from other chains — one CTA + supported-chain logos (non-interactive) */}
                  <div>
                    <div className="mb-2 flex items-center gap-3">
                      <span className="h-px flex-1 bg-gray-200" />
                      <span className="whitespace-nowrap text-xs font-medium text-gray-400">Pay from other chains</span>
                      <span className="h-px flex-1 bg-gray-200" />
                    </div>
                    <button
                      onClick={openOtherChains}
                      disabled={isPending}
                      className="w-full rounded-xl border border-gray-200 bg-white py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                    >
                      Pay from another chain
                    </button>
                    <div className="mt-2 flex items-center justify-end gap-1.5">
                      <BaseLogo className="h-5 w-5" />
                      <ArbitrumLogo className="h-5 w-5" />
                      <OptimismLogo className="h-5 w-5" />
                    </div>
                  </div>

                  {/* Returning Arc customers who never enabled cross-chain renewals
                      can turn them on here. New customers are offered it on the
                      success screen instead; the toggle self-hides for any wallet
                      that has already enabled it. */}
                  {!isPending && address && (walletVerified || isReturning) && (
                    <DelegatedRenewalToggle
                      sessionId={sessionId}
                      sessionToken={sessionToken}
                      walletAddress={address}
                      email={EMAIL_RE.test(email.trim()) ? email.trim() : undefined}
                      emailToken={emailToken}
                    />
                  )}
                </>
              )}

              {/* Returning customer: existing subscription(s) + Revoke (email-gated). */}
              {emailToken && emailValid && (
                <ManageSubscriptionsPanel
                  sessionId={sessionId}
                  email={email.trim()}
                  emailToken={emailToken}
                  connectedWallet={address}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {isTestMode && (
        <div className="border-t border-yellow-200 bg-yellow-50 px-6 py-3 text-center text-xs font-medium text-yellow-700">
          TEST MODE — No real USDC is charged
        </div>
      )}
    </div>
  );
}
