import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  useConfig,
  useDisconnect,
  useReadContract,
  useReconnect,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { getAccount, getChainId } from "wagmi/actions";
import { formatUnits } from "viem";
import { ERC20_ABI } from "@/lib/chain/abis";
import { arcTestnet } from "@/lib/chain/config";
import { GatewaySweepPanel } from "./GatewaySweepPanel";
import { DelegatedRenewalToggle } from "./DelegatedRenewalToggle";
import { ManageSubscriptionsPanel } from "./ManageSubscriptionsPanel";
import { PostPaymentGrants } from "./PostPaymentGrants";
import { ArcLogo, BaseLogo, ArbitrumLogo, OptimismLogo } from "./ChainBadge";
import { CheckoutFrame, RULE, HAIRLINE } from "./CheckoutFrame";
import { PlanShowcase } from "./PlanShowcase";
import { Turnstile, TURNSTILE_ENABLED } from "@/components/Turnstile";
import {
  enableCrossChain,
  fetchGrantPlan,
  fetchWalletAvailability,
  fetchWalletBalances,
  fetchWalletStatus,
  hydrateTypedData,
  requestOtp,
  saveDelegation,
  verifyOtp,
  type TypedDataPayload,
} from "@/lib/gateway";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";

/** An Arc EIP-2612 permit the subscriber has already signed, ready to submit. */
export interface SignedPermit {
  signature: `0x${string}`;
  permit_value: string;
  permit_deadline: string;
}

// Checkout is gasless by default: the subscriber signs ONE EIP-2612 permit
// (grants a year of renewals) and the platform submits subscribeWithPermit()
// on Arc, paying the gas. If that fails, the UI falls back to the direct path —
// two subscriber-submitted transactions: USDC.approve(amount × 12) + subscribe().
// Renewals always produce zero subscriber signatures.
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Chain names for the confirmation receipt. */
const CHAIN_NAMES: Record<string, string> = {
  arc: "Arc",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
};

interface Plan {
  name: string;
  description: string;
  amount: number; // USDC micro-units (6 decimals)
  currency: string;
  interval: string;
  trialDays: number;
  defaultTierName?: string | null;
  /** Tier id the merchant badged "Recommended"; "default" = the plan's own terms. */
  recommendedTierId?: string | null;
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

/**
 * A numbered, ruled step row in the payment column. Declared at module scope: a
 * component defined inside CheckoutShell would get a fresh identity on every
 * render, so React would unmount and remount each row — and the email input
 * inside 01 would lose focus after every keystroke.
 */
/**
 * Subscriber-facing text for wallet failures. "Connector not connected.
 * Version: @wagmi/core@2.22.1" is a library diagnostic, not something to put in
 * front of someone who is trying to pay.
 */
function friendlyWalletError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/connector not connected|no connector|getaccount/i.test(msg)) {
    return "Your wallet disconnected while confirming. Reconnect it and try again — nothing was charged.";
  }
  if (/user rejected|user denied|rejected the request|cancell?ed/i.test(msg)) {
    return "Signature cancelled — nothing was charged.";
  }
  return msg;
}

function StepRow({ n, label, children, strong = false }: {
  n: string; label: string; children: React.ReactNode; strong?: boolean;
}) {
  return (
    <div
      className="grid gap-3.5"
      style={{ gridTemplateColumns: "26px 1fr", padding: "13px 0", borderBottom: strong ? RULE : HAIRLINE }}
    >
      <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, color: "var(--color-accent)" }}>
        {n}
      </span>
      <div>
        <p className="m-0 uppercase" style={{ fontSize: 11, letterSpacing: "0.14em", marginBottom: 7 }}>{label}</p>
        {children}
      </div>
    </div>
  );
}

export function CheckoutShell({ sessionId, sessionToken, plan, tiers, merchant, isTestMode, cancelUrl, onchain }: Props) {
  const { address, isConnected, status: accountStatus } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();
  const { reconnect } = useReconnect();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();
  const wagmiConf = useConfig();

  /**
   * wagmi drops to `reconnecting` — isConnected false, address undefined — for a
   * beat whenever the wallet switches chains, and ensureArc() switches chains
   * before every signature. Rendering straight off isConnected therefore tore the
   * whole payment column down mid-signature: step 02 fell back to "Connect
   * wallet" and steps 03/04 unmounted while MetaMask was still prompting, and the
   * in-flight action then threw "Connector not connected".
   *
   * So latch the last account we saw. It is only genuinely gone once wagmi
   * settles on "disconnected", which is what an explicit disconnect produces.
   */
  const [lastAccount, setLastAccount] = useState<`0x${string}` | undefined>();
  useEffect(() => {
    if (address) setLastAccount(address);
    else if (accountStatus === "disconnected") setLastAccount(undefined);
  }, [address, accountStatus]);

  /** What the UI renders against — survives a transient reconnect. */
  const payAddress = address ?? lastAccount;
  const walletPresent = isConnected || (!!lastAccount && accountStatus !== "disconnected");

  /**
   * Wait out a transient `reconnecting` before touching the connector, and hand
   * back the address wagmi actually holds. Every wallet action goes through this
   * rather than through the render-time `address`, which may be a beat stale.
   */
  const ensureConnected = async (): Promise<`0x${string}`> => {
    for (let i = 0; i < 40; i++) {
      const acct = getAccount(wagmiConf);
      if (acct.status === "connected" && acct.address) return acct.address;
      if (acct.status === "disconnected") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const acct = getAccount(wagmiConf);
    if (acct.address) return acct.address;
    throw new Error("Your wallet disconnected. Reconnect it and try again — nothing was charged.");
  };

  // Ensure the wallet is on Arc and WAIT for the connector to report it — the
  // gasless permit is an Arc-domain EIP-712 payload, so signing it while the
  // wallet is still on another chain throws a chainId-mismatch.
  const ensureArc = async () => {
    if (getChainId(wagmiConf) === arcTestnet.id) return;
    await switchChainAsync({ chainId: arcTestnet.id });
    for (let i = 0; i < 40; i++) {
      if (getChainId(wagmiConf) === arcTestnet.id) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // The switch itself is what knocks the connector into `reconnecting`; settle
    // it here so the caller signs against a live connector.
    await ensureConnected();
  };
  const [step, setStep] = useState<Step>("idle");
  const [txHashDisplay, setTxHashDisplay] = useState<string | undefined>();
  /**
   * The chain the subscriber's USDC actually came from, for the receipt. Arc on
   * the direct and gasless paths; the sweep reports its own source chain, which
   * may differ from the row that was clicked — the panel falls back to whichever
   * authorized chain actually holds the funds.
   */
  const [paidFromChain, setPaidFromChain] = useState<string>("arc");
  /** The subscription just created — post-payment grants bind to it, not the session. */
  const [subscriptionId, setSubscriptionId] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState("");
  const [showSweep, setShowSweep] = useState(false);
  const [email, setEmail] = useState("");
  // Email is the identity anchor (per merchant); the wallet is the payment method
  // attached to it. Entering a known email recalls the returning customer and the
  // wallet they last paid with here.
  const [recalledWallet, setRecalledWallet] = useState<string | null>(null);

  // Email verification (OTP). A subscriber must be a verified customer of this
  // merchant before any activation: a returning wallet is recognized (walletVerified);
  // a new wallet/email proves ownership via a 6-digit code → emailToken.
  const [walletVerified, setWalletVerified] = useState(false);
  const [recognizedEmail, setRecognizedEmail] = useState<string | null>(null);
  // Set when the connected wallet already carries a live subscription with this
  // merchant for a DIFFERENT customer. One wallet cannot back two customers here:
  // they would share a USDC balance and a single allowance and drain each other.
  // Paying other merchants from this wallet is unaffected.
  const [walletBlocked, setWalletBlocked] = useState<string | null>(null);
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
    if (verified && isReturning && accountStatus === "disconnected" && !reconnectTried.current) {
      reconnectTried.current = true;
      reconnect();
    }
  }, [verified, isReturning, accountStatus, reconnect]);

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
    if (!payAddress) { setWalletVerified(false); setRecognizedEmail(null); return; }
    let cancelled = false;
    fetchWalletStatus(sessionId, payAddress)
      .then((s) => {
        if (cancelled) return;
        setWalletVerified(s.linked && s.verified);
        setRecognizedEmail(s.email_masked);
      })
      .catch(() => { if (!cancelled) { setWalletVerified(false); setRecognizedEmail(null); } });
    return () => { cancelled = true; };
  }, [payAddress, sessionId]);

  // Wallet availability: is this wallet spoken for at this merchant? Asked as soon
  // as it connects, so the answer lands before anything is signed rather than
  // after the subscriber has spent gas. Every activation path re-checks server-side.
  useEffect(() => {
    if (!payAddress) { setWalletBlocked(null); return; }
    let cancelled = false;
    fetchWalletAvailability(
      sessionId,
      payAddress,
      EMAIL_RE.test(email.trim()) ? email.trim() : undefined,
      emailToken
    )
      .then((a) => { if (!cancelled) setWalletBlocked(a.available ? null : a.message); })
      // A failed pre-flight must not block a legitimate payment — the server-side
      // guard still refuses, and refuses before any funds move on every path but
      // the direct one.
      .catch(() => { if (!cancelled) setWalletBlocked(null); });
    return () => { cancelled = true; };
  }, [address, sessionId, email, emailToken]);

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

  /**
   * The chains a subscriber can pay from, in the design's order.
   *
   * Arc settles directly; the rest are swept to Arc via CCTP. Selecting one is
   * JUST a selection — it opens no wallet, signs no delegation, and upgrades no
   * account. All of that happens when the subscriber presses the pay button,
   * which is the only control on this page that should ever reach the wallet.
   */
  const PAY_CHAINS = [
    { key: "arc", name: "USDC on Arc", note: "Recommended · gasless · instant settlement", Logo: ArcLogo },
    { key: "base", name: "USDC on Base", note: "Settled on Arc · ~20s", Logo: BaseLogo },
    { key: "arbitrum", name: "USDC on Arbitrum", note: "Settled on Arc · ~25s", Logo: ArbitrumLogo },
    { key: "optimism", name: "USDC on Optimism", note: "Settled on Arc · ~25s", Logo: OptimismLogo },
  ] as const;

  const [payChain, setPayChain] = useState<string>("arc");
  const payingFromArc = payChain === "arc";

  /** chain_keys already authorized in this session. */
  const [grantedChains, setGrantedChains] = useState<string[]>([]);
  const [grantingChain, setGrantingChain] = useState<string | null>(null);
  const [grantError, setGrantError] = useState("");
  /** Set once a chain is cleared to pay — drives the sweep panel's auto-run. */
  const [sweepChain, setSweepChain] = useState<string | null>(null);

  /**
   * Any source chain still unauthorized. Drives ONE one-time-setup notice under
   * the chain list — it used to be repeated on every source row, which spent
   * three copies of the same two lines and was the single largest block of
   * height in this column.
   *
   * The warning itself still matters: the EIP-7702 wallet setup a source chain
   * needs is submitted by MetaMask, not by our relayer, so it is the one cost we
   * cannot cover. Saying so before they click beats a surprise fee prompt.
   */
  const anySourceNeedsSetup = PAY_CHAINS.some(
    ({ key }) => key !== "arc" && !grantedChains.includes(key) && grantingChain !== key,
  );

  /**
   * Is there enough USDC on `key` to cover this charge?
   *
   * A trial charges nothing today, so any balance passes. Checked BEFORE any
   * wallet prompt: asking someone to approve a chain and only then telling them
   * it can't pay wastes two signatures and a chain switch.
   */
  const chainCanPay = async (key: string): Promise<boolean> => {
    if (hasTrial || !payAddress) return true;
    const balances = await fetchWalletBalances(payAddress);
    const held =
      key === "arc"
        ? BigInt(balances.arc_balance)
        : BigInt(balances.chains.find((c) => c.chain === key)?.wallet_balance ?? "0");
    return held >= planAmount;
  };

  /**
   * Clicking a chain is the payment action.
   *
   * Arc: sign the ERC-2612 permit and let the platform submit subscribeWithPermit.
   * Anything else: authorize THAT chain (7702 upgrade + one ERC-7715 delegation),
   * then sweep from it to Arc. Either way the balance is checked first, and a
   * short balance stops the flow before the wallet is ever opened.
   */
  const pickChain = async (key: string) => {
    if (grantingChain || isPending) return;
    setPayChain(key);
    setGrantError("");
    setErrorMsg("");
    if (!payAddress) return;
    if (walletBlocked) { setGrantError(walletBlocked); return; }

    setGrantingChain(key);
    try {
      if (!(await chainCanPay(key))) {
        setGrantError("Balance too low for payment. Try other chain");
        return;
      }

      if (key === "arc") {
        setGrantingChain(null);
        await onPayGasless();
        return;
      }

      // Authorize this chain only, unless it is already covered.
      if (!grantedChains.includes(key)) {
        const plan = await fetchGrantPlan(sessionId, payAddress);
        const target = plan.targets.find((t) => t.chain_key === key);
        if (!target) throw new Error("That chain isn't available for this plan.");
        if (!(plan.granted_chain_ids ?? []).includes(target.chain_id)) {
          const failures = await grantRenewalMandates(
            payAddress,
            [target],
            (input) => saveDelegation(sessionId, input)
          );
          if (failures.length > 0) throw new Error(`Couldn't authorize ${target.name}.`);
        }
        setGrantedChains((prev) => [...prev, key]);
        await enableCrossChain(sessionId, {
          session_token: sessionToken,
          wallet_address: payAddress,
          email: EMAIL_RE.test(email.trim()) ? email.trim() : undefined,
          email_token: emailToken ?? undefined,
        });
      }

      // Hand off to the sweep, which signs the Arc permit and activates.
      setSweepChain(key);
      setShowSweep(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGrantError(
        /rejected|denied|cancell?ed/i.test(msg)
          ? "Request cancelled — pick a chain again to continue."
          : msg || "Couldn't authorize that chain."
      );
    } finally {
      setGrantingChain(null);
    }
  };

  /**
   * The master switch's payment: authorize every chain that isn't yet granted,
   * then charge Arc first and fall back to whichever approved chain has funds.
   */
  const payAcrossAllChains = async () => {
    if (!payAddress) return;
    setGrantError("");
    if (walletBlocked) { setGrantError(walletBlocked); return; }
    if (await chainCanPay("arc")) {
      await onPayGasless();
      return;
    }
    const balances = await fetchWalletBalances(payAddress);
    const funded = balances.chains.find(
      (c) => BigInt(c.wallet_balance) >= planAmount && grantedChains.includes(c.chain)
    );
    if (!funded) {
      setGrantError("Balance too low for payment. Try other chain");
      return;
    }
    setPayChain(funded.chain);
    setSweepChain(funded.chain);
    setShowSweep(true);
  };

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

  // The Arc EIP-2612 permit. It covers BOTH the opening charge and a year of
  // renewals, so it is signed once and reused: "Automatic renewal" signs it as
  // part of authorizing every chain, and if the subscriber never turns that on,
  // the pay button signs it instead. Either way exactly one Arc permit exists.
  const [signedPermit, setSignedPermit] = useState<SignedPermit | null>(null);

  const signArcPermit = useCallback(async (): Promise<SignedPermit> => {
    // Mirror the chosen tier to the server, then ensure we're on Arc to sign —
    // the permit is an Arc-domain EIP-712 payload. ensureArc settles the
    // connector after the switch, and ensureConnected hands back the address
    // wagmi actually holds rather than the render-time one, which is undefined
    // for the beat the switch takes.
    await syncTier();
    await ensureArc();
    const signer = await ensureConnected();

    const permitRes = await fetch(`${API_URL}/internal/checkout/${sessionId}/permit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet_address: signer }),
    });
    if (!permitRes.ok) throw new Error("Could not prepare the permit");
    const permit = (await permitRes.json()) as {
      permit_payload: TypedDataPayload;
      permit_value: string;
      permit_deadline: string;
    };

    const signature = await signTypedDataAsync(hydrateTypedData(permit.permit_payload) as never);
    const signed: SignedPermit = {
      signature,
      permit_value: permit.permit_value,
      permit_deadline: permit.permit_deadline,
    };
    setSignedPermit(signed);
    return signed;
  }, [address, sessionId, signTypedDataAsync, syncTier, ensureArc]);

  // Gasless primary path — the platform submits subscribeWithPermit() on Arc and
  // pays the gas. Reuses the permit the renewal toggle already collected, if any.
  const onPayGasless = async () => {
    if (!payAddress) return;
    if (!verified) { setErrorMsg("Verify your email to continue."); return; }
    if (walletBlocked) { setErrorMsg(walletBlocked); return; }
    setErrorMsg("");

    try {
      setStep("approving"); // "Authorizing…" — single off-chain signature

      const payer = await ensureConnected();
      const permit = signedPermit ?? (await signArcPermit());
      const signature = permit.signature;

      setStep("confirming");
      const res = await fetch(`${API_URL}/internal/checkout/gasless`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          wallet_address: payer,
          email: email.trim(),
          email_token: emailToken,
          permit_signature: signature,
          permit_value: permit.permit_value,
          permit_deadline: permit.permit_deadline,
        }),
      });

      const activated = (await res.json().catch(() => ({}))) as {
        subscription_id?: string;
        tx_hash?: string;
        error?: { message?: string };
      };

      if (!res.ok) {
        // Every path is gasless for the subscriber, so there is nothing to fall
        // back to: a failure here is ours to fix or theirs to retry, never a
        // reason to hand them a gas bill.
        throw new Error(
          activated.error?.message ??
            "We couldn't complete this payment. Nothing was charged — please try again."
        );
      }

      if (activated.tx_hash) setTxHashDisplay(activated.tx_hash);
      if (activated.subscription_id) setSubscriptionId(activated.subscription_id);
      setStep("success");
    } catch (e: unknown) {
      setErrorMsg(friendlyWalletError(e));
      setStep("error");
    }
  };


  // ═══════════════════════════════════════════════════════════════════════════
  // Views. The Modernist system organises with rules and alignment, so each
  // view is a ruled grid rather than a stack of cards.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Step 3 — confirmed. */
  if (step === "success") {
    const rows: { k: string; v: string; mono?: boolean }[] = [
      { k: "Plan", v: selectedTierName },
      {
        k: hasTrial ? "Trial" : "Amount",
        v: hasTrial
          ? `${effectiveTrialDays} days free, then ${formattedAmount} ${plan.currency}`
          : `${formattedAmount} ${plan.currency} ${INTERVAL_LABELS[effectiveInterval] ?? ""}`.trim(),
      },
      { k: "Merchant", v: merchant.name },
      {
        // Where the money came FROM. Settlement is always Arc, so name both when
        // they differ rather than reporting only the chain that received it.
        k: "Network",
        v:
          paidFromChain === "arc"
            ? "Arc"
            : `${CHAIN_NAMES[paidFromChain] ?? paidFromChain} → settled on Arc`,
      },
      ...(address ? [{ k: "Wallet", v: address, mono: true }] : []),
      ...(txHashDisplay ? [{ k: "Transaction", v: txHashDisplay, mono: true }] : []),
    ];

    return (
      <CheckoutFrame merchant={merchant} isTestMode={isTestMode} cancelUrl={cancelUrl} rail="done">
        <div style={{ padding: "52px 32px 72px", maxWidth: 760 }}>
          <p
            className="m-0 uppercase"
            style={{ fontSize: 10, letterSpacing: "0.16em", color: "var(--color-accent)", marginBottom: 10 }}
          >
            Confirmed on Arc
          </p>
          <h1
            className="m-0"
            style={{ fontSize: "clamp(34px, 5vw, 60px)", letterSpacing: "-0.04em", lineHeight: 0.98, marginBottom: 14 }}
          >
            You&apos;re subscribed to {selectedTierName}.
          </h1>
          <p
            className="m-0"
            style={{ fontSize: 16, color: "var(--color-neutral-800)", marginBottom: 32, maxWidth: "52ch" }}
          >
            {hasTrial
              ? `Your ${effectiveTrialDays}-day free trial has started. `
              : `${plan.name} is now active. `}
            Renewals run automatically — nothing else to sign.
          </p>

          <div style={{ borderTop: RULE, borderBottom: RULE, background: "var(--color-bg)" }}>
            {rows.map((r) => (
              <div
                key={r.k}
                className="flex justify-between gap-5"
                style={{ padding: "14px 20px", borderBottom: HAIRLINE }}
              >
                <span
                  className="uppercase"
                  style={{ fontSize: 12, letterSpacing: "0.1em", color: "var(--color-neutral-700)" }}
                >
                  {r.k}
                </span>
                <span
                  style={{
                    fontSize: 13.5,
                    textAlign: "right",
                    wordBreak: "break-all",
                    fontFamily: r.mono ? "ui-monospace, Menlo, monospace" : undefined,
                  }}
                >
                  {r.v}
                </span>
              </div>
            ))}
          </div>

          {/* Chains authorized so far, and the rest a click away. Bound to the
              new subscription — the checkout session is spent by now. */}
          {subscriptionId && payAddress && (
            <PostPaymentGrants
              subscriptionId={subscriptionId}
              sessionId={sessionId}
              sessionToken={sessionToken}
              walletAddress={payAddress}
              email={EMAIL_RE.test(email.trim()) ? email.trim() : undefined}
              emailToken={emailToken}
              alreadyGranted={grantedChains}
            />
          )}

          <div className="flex flex-wrap gap-3" style={{ marginTop: 28 }}>
            <a className="btn btn-primary" style={{ padding: "13px 20px" }} href={cancelUrl}>
              Back to {merchant.name}
            </a>
            <a
              className="btn btn-secondary"
              style={{ padding: "13px 20px" }}
              href="/manage"
              target="_blank"
              rel="noreferrer"
            >
              Manage subscription
            </a>
          </div>
        </div>
      </CheckoutFrame>
    );
  }

  const isPending = step === "approving" || step === "subscribing" || step === "confirming";

  // ─── Step 1: choose a plan (multi-tier) ────────────────────────────────────
  if (view === "plans" && tierOptions.length > 1) {
    return (
      <CheckoutFrame merchant={merchant} isTestMode={isTestMode} cancelUrl={cancelUrl} rail="pick">
        <PlanShowcase
          merchantName={merchant.name}
          description={plan.description}
          tierOptions={tierOptions}
          recommendedTierId={plan.recommendedTierId}
          // Choosing a plan carries you straight to payment with that tier.
          onChoose={(id) => { setSelectedTierId(id); setView("pay"); }}
        />
      </CheckoutFrame>
    );
  }

  // ─── Step 2: payment details ───────────────────────────────────────────────
  const previewFeatures = selectedTier?.features ?? plan.defaultFeatures ?? [];

  return (
    <CheckoutFrame merchant={merchant} isTestMode={isTestMode} cancelUrl={cancelUrl} rail="pay">
      <div className="grid lg:grid-cols-[0.85fr_1.15fr]" style={{ minHeight: "100%" }}>
        {/* ─── Left: the chosen plan ─────────────────────────────────────── */}
        <aside
          style={{ padding: "36px 32px", background: "var(--color-surface)", borderRight: RULE }}
        >
          <p
            className="m-0 uppercase"
            style={{ fontSize: 10, letterSpacing: "0.16em", color: "var(--color-neutral-600)", marginBottom: 18 }}
          >
            Your plan
          </p>
          <p className="m-0 uppercase" style={{ fontSize: 11, letterSpacing: "0.14em", marginBottom: 6 }}>
            {selectedTierName}
          </p>
          <p
            className="m-0"
            style={{
              fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: "clamp(40px, 6vw, 60px)",
              lineHeight: 1, letterSpacing: "-0.04em", marginBottom: 4,
            }}
          >
            {hasTrial ? "Free" : formattedAmount}
          </p>
          <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)", marginBottom: 22 }}>
            {hasTrial
              ? `for ${effectiveTrialDays} days, then ${formattedAmount} ${plan.currency} ${INTERVAL_LABELS[effectiveInterval] ?? ""}`
              : `${plan.currency} ${INTERVAL_LABELS[effectiveInterval] ?? ""}`}
          </p>

          {previewFeatures.length > 0 && (
            <div className="flex flex-col gap-2" style={{ borderTop: RULE, paddingTop: 16 }}>
              {previewFeatures.slice(0, 6).map((f, i) => (
                <span key={i} className="flex gap-2.5" style={{ fontSize: 13, lineHeight: 1.45 }}>
                  <span style={{ color: "var(--color-accent)", fontFamily: "var(--font-heading)", fontWeight: 800 }}>
                    —
                  </span>
                  {f}
                </span>
              ))}
            </div>
          )}

          {tiers.length > 0 && !isPending && (
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginTop: 22, padding: 0, fontSize: 12.5 }}
              onClick={() => setView("plans")}
            >
              ← Change plan
            </button>
          )}

          <div style={{ borderTop: HAIRLINE, marginTop: 26, paddingTop: 14 }}>
            <p className="m-0" style={{ fontSize: 11.5, color: "var(--color-neutral-700)", lineHeight: 1.6 }}>
              Cancel anytime by revoking the authorization from your wallet. Refunds inside the
              settlement window settle back on-chain.
            </p>
          </div>
        </aside>

        {/* ─── Right: payment details ────────────────────────────────────── */}
        <main
          className="flex flex-col"
          style={{ padding: "24px 32px 20px", background: "var(--color-bg)" }}
        >
          <h1 className="m-0" style={{ fontSize: "clamp(20px, 2.2vw, 24px)", letterSpacing: "-0.03em", marginBottom: 14 }}>
            Payment details
          </h1>

          {showSweep && payAddress ? (
            /* Cross-chain path: sweep USDC from Base / Arbitrum / Optimism */
            <GatewaySweepPanel
              preferredChainKey={sweepChain ?? payChain}
              autoStart={sweepChain !== null}
              sessionId={sessionId}
              sessionToken={sessionToken}
              walletAddress={payAddress}
              email={EMAIL_RE.test(email.trim()) ? email.trim() : undefined}
              emailToken={emailToken}
              onSuccess={(txHash, sourceChain, subId) => {
                if (txHash) setTxHashDisplay(txHash);
                if (sourceChain) setPaidFromChain(sourceChain);
                // Without this the confirmation page's renewal permissions never
                // render after a cross-chain payment — they bind to the
                // subscription, and only the gasless path was setting it.
                if (subId) setSubscriptionId(subId);
                setStep("success");
              }}
              onClose={() => setShowSweep(false)}
            />
          ) : (
            <>
              <div style={{ borderTop: RULE }}>
                {/* 01 — email, verified first, before any wallet connection */}
                <StepRow n="01" label="Email">
                  {!verified ? (
                    <>
                      <p className="m-0" style={{ fontSize: 12.5, color: "var(--color-neutral-700)", marginBottom: 10 }}>
                        {isReturning
                          ? `Welcome back — you've paid here before with ${recalledWallet}. Verify your email to continue.`
                          : "Verify your email to continue — we'll send you a 6-digit code."}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <input
                          type="email"
                          className="input"
                          style={{ flex: 1, minWidth: 200 }}
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            e.preventDefault();
                            if (emailValid && otpPhase !== "sending" && !(TURNSTILE_ENABLED && !otpCaptcha)) void onSendCode();
                          }}
                          placeholder="you@example.com"
                          name="email"
                          autoComplete="email"
                          inputMode="email"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          enterKeyHint="send"
                        />
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={onSendCode}
                          disabled={!emailValid || otpPhase === "sending" || (TURNSTILE_ENABLED && !otpCaptcha)}
                        >
                          {otpPhase === "sending"
                            ? "Sending…"
                            : otpPhase === "sent" || otpPhase === "verifying" ? "Resend" : "Send code"}
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
                            className="input"
                            style={{ width: 140, fontVariantNumeric: "tabular-nums" }}
                            inputMode="numeric"
                            maxLength={6}
                            value={otpCode}
                            onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                            placeholder="6-digit code"
                          />
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={onVerifyCode}
                            disabled={otpCode.trim().length !== 6 || otpPhase === "verifying"}
                          >
                            {otpPhase === "verifying" ? "Verifying…" : "Verify"}
                          </button>
                        </div>
                      )}
                      {otpError && (
                        <p className="m-0 mt-2" style={{ fontSize: 12, color: "var(--color-accent-700)" }}>{otpError}</p>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span style={{ width: 9, height: 9, background: "var(--color-accent)", display: "block" }} />
                      <span style={{ fontSize: 14 }}>
                        {emailToken ? email.trim() : recognizedEmail ?? "your account"}
                      </span>
                      <span className="tag tag-outline ml-auto">Verified</span>
                    </div>
                  )}
                </StepRow>

                {/* 02 — wallet */}
                {verified && (
                  <StepRow n="02" label="Wallet">
                    {!walletPresent ? (
                      isReturning ? (
                        <>
                          <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
                            You previously paid here with
                          </p>
                          <p
                            className="m-0 mt-1"
                            style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13.5 }}
                          >
                            {recalledWallet}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button type="button" className="btn btn-primary" onClick={onConnect}>
                              Connect to continue
                            </button>
                            <button type="button" className="btn btn-ghost" onClick={onConnect}>
                              Use a different wallet
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <p className="m-0" style={{ fontSize: 13, color: "var(--color-neutral-700)", marginBottom: 10 }}>
                            Connect your wallet to pay with USDC.
                          </p>
                          <button type="button" className="btn btn-primary" onClick={onConnect}>
                            Connect wallet
                          </button>
                        </>
                      )
                    ) : (
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13.5 }}>
                          {shortAddr(payAddress)}
                        </span>
                        {usdcBalance !== undefined && (
                          <span className="tag tag-neutral">
                            Balance {formatUnits(usdcBalance, 6)} USDC
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost ml-auto"
                          style={{ fontSize: 12.5, padding: 0 }}
                          onClick={onUseDifferentWallet}
                        >
                          Use a different wallet
                        </button>
                        {walletBlocked && (
                          <p
                            className="m-0 w-full"
                            style={{ fontSize: 12.5, color: "var(--color-accent-700)", marginTop: 4 }}
                          >
                            {walletBlocked}
                          </p>
                        )}
                      </div>
                    )}
                  </StepRow>
                )}

                {/* 03 — pay from. One row per chain, exactly as the design
                    has it. These are radio rows: picking one records a choice
                    and nothing else. The previous version collapsed the three
                    source chains into a single row whose click jumped straight
                    into the grant-all flow, so a subscriber curious about Base
                    was immediately asked to authorize every chain. */}
                {verified && walletPresent && !walletBlocked && (
                  <StepRow n="03" label="Pay from">
                    <div className="flex flex-col" role="radiogroup" aria-label="Pay from">
                      {PAY_CHAINS.map(({ key, name, note, Logo }) => {
                        const on = payChain === key;
                        const isArc = key === "arc";
                        // Only Arc's row depends on the Arc balance; a sweep
                        // chain is selectable regardless of what's on Arc.
                        const short = isArc && !hasEnoughBalance;
                        return (
                          <button
                            key={key}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => void pickChain(key)}
                            disabled={isPending || grantingChain !== null}
                            className="flex items-center gap-3.5 text-left"
                            style={{
                              background: on ? "var(--color-surface)" : "transparent",
                              border: 0,
                              borderTop: HAIRLINE,
                              borderLeft: `3px solid ${on ? "var(--color-accent)" : "transparent"}`,
                              padding: "9px 14px",
                              cursor: isPending ? "not-allowed" : "pointer",
                              fontFamily: "var(--font-body)",
                            }}
                          >
                            <Logo className="h-[22px] w-[22px] shrink-0" />
                            <span className="min-w-0 flex-1">
                              <span
                                className="block"
                                style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 14.5 }}
                              >
                                {name}
                              </span>
                              <span
                                className="mt-0.5 block"
                                style={{ fontSize: 11.5, color: "var(--color-neutral-700)" }}
                              >
                                {isPending && on
                                  ? "Processing payment…"
                                  : grantingChain === key
                                    // Just say the wallet has the ball. Naming the
                                    // account upgrade and the permission step
                                    // described our plumbing, not the subscriber's
                                    // task, and read as if something extra were
                                    // being asked of them.
                                    ? "Confirm in your wallet…"
                                    : grantedChains.includes(key)
                                      ? "Authorized · renewals can charge from here"
                                      : short
                                        ? usdcBalance === undefined && !hasTrial
                                          ? "Checking your Arc balance…"
                                          : "Not enough USDC on Arc — pick another chain."
                                        : note}
                              </span>
                            </span>
                            <span
                              className="shrink-0"
                              style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 14 }}
                            >
                              {hasTrial ? (
                                "Free"
                              ) : (
                                <>
                                  {formattedAmount}{" "}
                                  {/* Currency muted and smaller, as in the totals
                                      row — naming it is what makes the row read as
                                      a price rather than a bare figure. */}
                                  <span style={{ fontSize: 11.5, color: "var(--color-neutral-700)" }}>
                                    {plan.currency}
                                  </span>
                                </>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {grantError && (
                      <p className="m-0 mt-2" style={{ fontSize: 12, color: "var(--color-accent-700)" }}>
                        {grantError}
                      </p>
                    )}

                    {(!payingFromArc || anySourceNeedsSetup) && (
                      <p
                        className="m-0 mt-2"
                        style={{ fontSize: 11, color: "var(--color-neutral-700)", lineHeight: 1.5 }}
                      >
                        {!payingFromArc && `${merchant.name} receives the full amount. `}
                        {anySourceNeedsSetup &&
                          "Paying from Base, Arbitrum or Optimism for the first time, your wallet may ask for a one-time setup — a few cents of gas. Every charge after is on us."}
                      </p>
                    )}

                  </StepRow>
                )}

                {/* 04 — automatic renewal. Shown as soon as a wallet is connected:
                    this is a decision the subscriber makes alongside the payment
                    details, so it must be on screen with them, not revealed later. */}
                {verified && walletPresent && !walletBlocked && payAddress && (
                  <StepRow n="04" label="Automatic renewal" strong>
                    <DelegatedRenewalToggle
                      sessionId={sessionId}
                      sessionToken={sessionToken}
                      walletAddress={payAddress}
                      email={EMAIL_RE.test(email.trim()) ? email.trim() : undefined}
                      emailToken={emailToken}
                      signArcPermit={signArcPermit}
                      arcPermitSigned={signedPermit !== null}
                      onAuthorizedAll={() => void payAcrossAllChains()}
                    />
                  </StepRow>
                )}
              </div>

              {step === "error" && (
                <p className="m-0" style={{ marginTop: 16, fontSize: 13, color: "var(--color-accent-700)" }}>
                  {errorMsg}
                </p>
              )}

              {/* Totals */}
              {verified && walletPresent && !walletBlocked && (
                <div style={{ marginTop: 14 }}>
                  <div
                    className="flex justify-between"
                    style={{ padding: "7px 0", borderBottom: HAIRLINE, fontSize: 13.5 }}
                  >
                    <span>Subtotal</span>
                    <span>{formattedAmount} {plan.currency}</span>
                  </div>
                  {hasTrial && (
                    <div
                      className="flex justify-between"
                      style={{ padding: "7px 0", borderBottom: HAIRLINE, fontSize: 13.5 }}
                    >
                      <span>Trial credit</span>
                      <span style={{ color: "var(--color-accent)" }}>−{formattedAmount} {plan.currency}</span>
                    </div>
                  )}
                  <div
                    className="flex justify-between"
                    style={{ padding: "7px 0", borderBottom: HAIRLINE, fontSize: 13.5 }}
                  >
                    <span>Network fee</span>
                    <span style={{ color: "var(--color-accent)" }}>Covered by Sweep Console</span>
                  </div>
                  <div
                    className="flex items-baseline justify-between"
                    style={{ padding: "11px 0", borderBottom: "2px solid var(--color-text)" }}
                  >
                    <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 18 }}>
                      Due today
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-heading)", fontWeight: 800,
                        fontSize: 27, letterSpacing: "-0.03em",
                      }}
                    >
                      {hasTrial ? "0.00" : formattedAmount}{" "}
                      <span style={{ fontSize: 15, color: "var(--color-neutral-700)" }}>{plan.currency}</span>
                    </span>
                  </div>

                  <p className="m-0" style={{ fontSize: 11, color: "var(--color-neutral-700)", marginTop: 8 }}>
                    Pick a chain above to pay.
                  </p>
                </div>
              )}

              {/* Returning customer: existing subscription(s) + Revoke (email-gated). */}
              {emailToken && emailValid && (
                <div style={{ marginTop: 18 }}>
                  <ManageSubscriptionsPanel
                    sessionId={sessionId}
                    email={email.trim()}
                    emailToken={emailToken}
                    connectedWallet={address}
                  />
                </div>
              )}
            </>
          )}

          {/* The column runs long — email, wallet, four chains, renewal, totals —
              and previously just stopped, leaving the subscriber unsure whether
              anything else was below. This closes it the way the plan column
              closes on its own rule. marginTop:auto pins it to the bottom of the
              stretched column when the content is short, and sits directly under
              the content when it isn't. */}
          <div style={{ borderTop: RULE, marginTop: "auto", paddingTop: 10 }}>
            <p
              className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1"
              style={{ fontSize: 11, color: "var(--color-neutral-600)", lineHeight: 1.6 }}
            >
              <span
                style={{
                  fontFamily: "var(--font-heading)", fontWeight: 800,
                  color: "var(--color-text)",
                }}
              >
                Sweep Console
              </span>
              <span aria-hidden="true">·</span>
              <span>Settled on Arc in {plan.currency}</span>
              <span aria-hidden="true">·</span>
              <span>Gas and bridge fees covered</span>
              <span aria-hidden="true">·</span>
              <span>Non-custodial — funds go straight to {merchant.name}</span>
            </p>
          </div>
        </main>
      </div>
    </CheckoutFrame>
  );
}
