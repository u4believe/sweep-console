import { useState, type JSX, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAccount, useConnectorClient } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits } from "viem";
import { Logo } from "@/components/ui/Logo";
import { BaseLogo, ArbitrumLogo, OptimismLogo } from "@/components/checkout/ChainBadge";
import { Spinner, ActivityBar } from "@/components/ui/Spinner";
import { Turnstile, TURNSTILE_ENABLED } from "@/components/Turnstile";
import { getSupportedDelegationChainIds } from "@/lib/delegation/capabilities";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
import { friendlyError } from "@/lib/errors";
import {
  portalRequestOtp,
  verifyOtp,
  portalListSubscriptions,
  portalCancelSubscription,
  portalGrantPlan,
  portalSaveGrant,
  portalRevokeGrant,
  type PortalSubscription,
  type PortalSupportedChain,
  type PortalPayment,
} from "@/lib/gateway";

// Standalone, cross-merchant customer portal. Email + OTP proves ownership; the
// customer then sees and manages every SweepConsole subscription tied to that
// email across all merchants — cancel (no escrow to return) and enable/revoke
// the cross-chain renewal grant. No checkout session, no merchant context needed.

// Not a flag any more — see DelegatedRenewalToggle. Grants are how renewals are
// collected, so the section that manages them cannot be optional.
const TIER2_ENABLED = true;

/// The API sends a chain key ("base"); this is the name a person reads. Falls
/// back to the key rather than a chain id, which means nothing to a subscriber.
const CHAIN_NAMES: Record<string, string> = {
  base: "Base",
  optimism: "Optimism",
  arbitrum: "Arbitrum",
  arc: "Arc",
};

/// The wallet that signed this subscription is the only one that can authorize
/// for it: renewals redeem against subscription.walletAddress, so a grant from
/// any other wallet is unredeemable — and paying gas for a 7702 upgrade on the
/// wrong account is a cost the subscriber cannot get back. One person can hold
/// several subscriptions across merchants on different wallets, so this is a
/// per-subscription question, never a per-session one.
function shortAddr(a: string): string {
  return a.length >= 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function walletMatches(connected: string | undefined, required: string): boolean {
  return !!connected && connected.toLowerCase() === required.toLowerCase();
}

/// Their authorization no longer reaches the price. Not a payment failure —
/// nothing is charged and nothing fails — so unless the page says so, the only
/// symptom is a subscription that quietly stops being collected.
function needsReauthorization(s: PortalSubscription): boolean {
  if (s.status === "cancelled" || s.grants.length === 0) return false;
  const best = s.grants.reduce((max, g) => (g.period_amount > max ? g.period_amount : max), 0);
  return best < s.plan.amount;
}

function chainLabel(chainId: number, s: PortalSubscription): string {
  const g = s.grants.find((x) => x.chain_id === chainId);
  if (!g) return "Cross-chain";
  return CHAIN_NAMES[g.chain] ?? g.chain;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/// Every settlement lands on Arc, so one explorer covers every receipt here.
/// Mirrors lib/chain/config.ts — kept as a constant because this page never has
/// a viem chain object to read it from.
const EXPLORER = import.meta.env.VITE_ARC_EXPLORER_URL ?? "https://testnet.arcscan.app";
const INTERVAL_LABELS: Record<string, string> = {
  daily: "/ day",
  weekly: "/ week",
  monthly: "/ month",
  yearly: "/ year",
};

/// "daily" is what the API stores; a sentence needs the noun.
const INTERVAL_NOUN: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

const PER_NOUN: Record<string, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

const fmtUsdc = (micro: number) => formatUnits(BigInt(micro), 6).replace(/\.0+$/, "");
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const CHAIN_LOGOS: Record<string, (p: { className?: string }) => JSX.Element> = {
  base: BaseLogo,
  arbitrum: ArbitrumLogo,
  optimism: OptimismLogo,
};

function Kpi({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: boolean }) {
  return (
    <div className="border-r border-gray-200 px-5 py-3 last:border-r-0" style={{ minWidth: 84 }}>
      <p className="m-0 text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400">{label}</p>
      <p className="m-0 mt-0.5 text-2xl font-bold leading-none tracking-tight" style={{ color: accent ? "var(--color-accent)" : undefined }}>
        {value}
        {unit && <span className="ml-1 text-[11px] font-semibold text-gray-500">{unit}</span>}
      </p>
    </div>
  );
}

/// What state this subscription is in, in the subscriber's terms. "Action
/// needed" outranks the stored status: a past_due row whose cap no longer covers
/// the price is not a failed payment, it is a price waiting on a signature.
function StatusChip({ sub }: { sub: PortalSubscription }) {
  const attention = needsReauthorization(sub);
  const label = attention
    ? "Action needed"
    : sub.status === "trialing"
      ? "Trial"
      : sub.status === "past_due"
        ? "Past due"
        : "Active";
  return (
    <span
      className="shrink-0 whitespace-nowrap border px-1.5 py-0.5 text-[10px] font-semibold"
      style={
        attention || sub.status === "past_due"
          ? { borderColor: "var(--color-accent)", color: "var(--color-accent)" }
          : { borderColor: "#bcd6f5", color: "#2359a6" }
      }
    >
      {label}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className="border-r border-gray-200 px-5 py-3.5 last:border-r-0">
      <p className="m-0 text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400">{label}</p>
      <p className="m-0 mt-1 text-sm" style={{ color: accent ? "var(--color-accent)" : "#111827" }}>{value}</p>
    </div>
  );
}

type Phase = "login" | "code" | "list";

function describeError(e: unknown): string {
  return friendlyError(e, "Something went wrong. Please try again.");
}

export function ManageSubscriptionsPage() {
  const { address } = useAccount();
  const { data: connectorClient } = useConnectorClient();
  const { openConnectModal } = useConnectModal();

  const [phase, setPhase] = useState<Phase>("login");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailToken, setEmailToken] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);

  const [subs, setSubs] = useState<PortalSubscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  /// Which subscription the detail pane shows. Null until the list arrives.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [supportedChains, setSupportedChains] = useState<PortalSupportedChain[]>([]);

  const emailValid = EMAIL_RE.test(email.trim());

  const sendCode = async () => {
    if (!emailValid) return setError("Enter a valid email.");
    if (TURNSTILE_ENABLED && !captcha) return setError("Complete the captcha first.");
    setError("");
    setLoading(true);
    try {
      await portalRequestOtp(email.trim(), captcha);
      setPhase("code");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setCaptchaReset((n) => n + 1);
      setLoading(false);
    }
  };

  const verify = async () => {
    if (!/^\d{6}$/.test(code.trim())) return setError("Enter the 6-digit code.");
    setError("");
    setLoading(true);
    try {
      const { email_token } = await verifyOtp(email.trim(), code.trim());
      setEmailToken(email_token);
      const res = await portalListSubscriptions(email.trim(), email_token);
      setSubs(res.subscriptions);
      setSupportedChains(res.supported_chains ?? []);
      // Open on whatever needs them, not simply the newest — the banner above
      // says something is wrong, and the pane under it should be showing it.
      const first = res.subscriptions.find(needsReauthorization) ?? res.subscriptions[0];
      setSelectedId(first?.id ?? null);
      setPhase("list");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  };

  const reload = async () => {
    const res = await portalListSubscriptions(email.trim(), emailToken).catch(() => null);
    if (!res) return;
    setSubs(res.subscriptions);
    if (res.supported_chains) setSupportedChains(res.supported_chains);
    // Keep the open subscription open. Without this a cancel or a grant drops
    // the reader back to the top of a list they were working inside.
    setSelectedId((cur) => (cur && res.subscriptions.some((x) => x.id === cur) ? cur : res.subscriptions[0]?.id ?? null));
  };

  const onCancel = async (s: PortalSubscription) => {
    if (!confirm(`Cancel your ${s.plan.name} subscription with ${s.merchant.name}? You won't be charged again. Charges already taken are not reversed.`)) return;
    setBusyId(s.id);
    setError("");
    setNotice("");
    try {
      await portalCancelSubscription(email.trim(), emailToken, s.id);
      setNotice(
        "Cancelled. You won't be charged again. Your renewal permission is now dormant — " +
          "you can also revoke it in your wallet for full on-chain control."
      );
      await reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  };

  const onEnableGrant = async (s: PortalSubscription) => {
    if (!address || !connectorClient) {
      openConnectModal?.();
      return;
    }
    // Checked before anything is signed. Granting from the wrong wallet costs
    // gas for an upgrade and a delegation that no renewal can ever redeem.
    if (!walletMatches(address, s.wallet_address)) {
      setError(
        `This subscription pays from ${shortAddr(s.wallet_address)}. You're connected as ` +
          `${shortAddr(address)} — switch to that wallet to authorize, because only the wallet that ` +
          `signed up can approve charges for it.`
      );
      // Open the picker rather than leaving them to find it: a button that says
      // "Switch to 0x…" and only prints an error is a dead end.
      openConnectModal?.();
      return;
    }
    // Captured before the grant lands, since afterwards the caps cover the price
    // and the case is indistinguishable from a first-time enable.
    const reauthorizing = needsReauthorization(s);
    setBusyId(s.id);
    setError("");
    setNotice("");
    try {
      // null ⇒ the probe gave no usable answer. Attempt the grant anyway: some
      // MetaMask builds refuse the probe and then service the request fine, and
      // a refused prompt is a better outcome than a dead end (capabilities.ts).
      const supported = await getSupportedDelegationChainIds(connectorClient);
      const { targets, granted_chain_ids } = await portalGrantPlan(email.trim(), emailToken, s.id, address);
      const walletCan = supported ? targets.filter((t) => supported.includes(t.chain_id)) : targets;
      // Don't ask the wallet to sign a chain this subscription is already covered
      // on. Each grant mints a NEW on-chain delegation that nothing ever cleans
      // up — only the subscriber can disable one, and it costs them gas — so a
      // redundant prompt leaves a permanent authorization behind.
      const usable = walletCan.filter((t) => !granted_chain_ids.includes(t.chain_id));
      if (walletCan.length === 0) {
        setError("You need USDC on a supported chain (Base, Arbitrum, or Optimism) your wallet can authorize.");
        return;
      }
      if (usable.length === 0) {
        setNotice("Already authorized on every chain your wallet supports — nothing more to sign.");
        await reload();
        return;
      }
      await grantRenewalMandates(
        address,
        usable,
        (input) => portalSaveGrant(email.trim(), emailToken, s.id, input),
        undefined,
        s.merchant.name
      );
      setNotice(
        reauthorizing
          ? // Says that a re-grant ADDS a permission rather than replacing one.
            // We cannot remove the old one — disableDelegation is onlyDeleGator —
            // and we no longer hold the means to use it, since re-granting
            // overwrote the stored context. But it is still a standing
            // authorization in their wallet, and someone who assumes it was
            // replaced is wrong about what they are carrying.
            `Approved. ${s.merchant.name} can now collect the new price, and your subscription continues ` +
            `from the next renewal. Your earlier permission is still in your wallet — approving a new one ` +
            `adds it rather than replacing it. We can no longer charge the old one, and it allowed less ` +
            `than the new one does, but only you can remove it: disable it in your wallet's permissions ` +
            `whenever you like.`
          : "Cross-chain renewals enabled. Renewals can now fall back to your USDC on other chains."
      );
      await reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Authorize ONE chain.
   *
   * The all-chains version below still exists for approving a price change,
   * where the subscriber's answer is "yes, keep my subscription" rather than a
   * choice about networks. Here the row is the question, so the row is the unit:
   * granting Arbitrum should not also prompt for Optimism.
   */
  const onGrantChain = async (s: PortalSubscription, chainId: number) => {
    if (!address || !connectorClient) return openConnectModal?.();
    if (!walletMatches(address, s.wallet_address)) {
      setError(
        `This subscription pays from ${shortAddr(s.wallet_address)}. You're connected as ` +
          `${shortAddr(address)} — switch to that wallet, because only the wallet that signed up can ` +
          `approve charges for it.`
      );
      openConnectModal?.();
      return;
    }
    setBusyId(`${s.id}:${chainId}`);
    setError("");
    setNotice("");
    try {
      const { targets, granted_chain_ids } = await portalGrantPlan(email.trim(), emailToken, s.id, address);
      if (granted_chain_ids.includes(chainId)) {
        setNotice("That chain is already authorized.");
        await reload();
        return;
      }
      const target = targets.find((t) => t.chain_id === chainId);
      if (!target) {
        setError("That chain isn't available for this subscription.");
        return;
      }
      const supported = await getSupportedDelegationChainIds(connectorClient);
      if (supported && !supported.includes(chainId)) {
        setError("Your wallet can't authorize that chain.");
        return;
      }
      const failures = await grantRenewalMandates(
        address,
        [target],
        (input) => portalSaveGrant(email.trim(), emailToken, s.id, input),
        undefined,
        s.merchant.name
      );
      setNotice(
        failures.length > 0
          ? "That chain wasn't authorized — nothing was signed."
          : `${target.name} authorized. Renewals can now be collected from it.`
      );
      await reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  };

  const onRevokeGrant = async (s: PortalSubscription, chainId?: number, isLast = false) => {
    // Turning off the last chain ends the subscription — every payment is
    // cross-chain, so there is nothing left to bill. Ask before, not after.
    if (isLast && !confirm(
      `${chainLabel(chainId!, s)} is the only chain authorized for this subscription. ` +
      "Turning it off leaves nothing to charge, so the subscription will go past due and be cancelled " +
      "if you don't re-authorize. Continue?"
    )) return;

    // Busy is keyed per chain so turning off Base does not grey out Optimism's
    // button next to it.
    setBusyId(chainId === undefined ? s.id : `${s.id}:${chainId}`);
    setError("");
    setNotice("");
    try {
      const r = await portalRevokeGrant(email.trim(), emailToken, s.id, chainId);
      // Says what this actually did. Revoking here stops US redeeming the mandate;
      // it cannot remove the permission from the subscriber's wallet, because
      // disableDelegation is onlyDeleGator. Claiming otherwise left people
      // believing an authorization was gone while it was still signed and live.
      //
      // And it no longer claims billing continues on Arc. Arc is settlement-only:
      // with no chains authorized there is nothing to charge at all.
      const where = chainId === undefined ? "Cross-chain renewals" : `${chainLabel(chainId, s)} renewals`;
      setNotice(
        r.remaining_chains === 0
          ? `${where} turned off. That was the only chain authorized, so there is nothing left to charge — ` +
            "the subscription is now past due and will be cancelled unless you authorize a chain again. " +
            "The permission you signed stays in your wallet until you revoke it there."
          : `${where} turned off — we won't charge that chain again. Renewals continue on your ` +
            `${r.remaining_chains} remaining authorized ${r.remaining_chains === 1 ? "chain" : "chains"}. ` +
            "The permission you signed stays in your wallet until you revoke it there."
      );
      await reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header className="flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo height={28} />
          <span className="text-lg font-bold tracking-tight text-gray-900">Sweep Console</span>
          <span className="ml-2 border-l border-gray-200 pl-2.5 text-sm text-gray-500">Customer portal</span>
        </Link>
        {phase === "list" ? (
          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-gray-500 sm:inline">{email.trim()}</span>
            {/* Which wallet is connected is the question behind half the
                controls below — whether a chain can be granted, whether a price
                can be approved — so it belongs in the chrome, not buried in a
                row's error text. */}
            <div className="flex items-center border border-gray-900 text-xs">
              <span className="flex items-center gap-1.5 px-2.5 py-1.5 font-mono">
                <span className="h-2 w-2" style={{ background: address ? "var(--color-accent)" : "#9ca3af" }} />
                {address ? shortAddr(address) : "No wallet"}
              </span>
              <button
                onClick={() => openConnectModal?.()}
                className="border-l border-gray-900 px-2.5 py-1.5 font-semibold text-brand-700 transition hover:bg-gray-900 hover:text-white"
              >
                {address ? "Switch" : "Connect"}
              </button>
            </div>
          </div>
        ) : (
          <Link to="/" className="text-sm font-medium text-gray-600 transition hover:text-gray-900">Home</Link>
        )}
      </header>

      <main className={`mx-auto w-full flex-1 px-6 py-12 ${phase === "list" ? "max-w-6xl" : "max-w-2xl"}`}>
        {phase !== "list" && (
          <div className="mx-auto max-w-md rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
            <h1 className="text-xl font-bold text-gray-900">Manage your subscriptions</h1>
            <p className="mt-1 text-sm text-gray-500">
              Enter your email and we&apos;ll send a 6-digit code. You&apos;ll see every subscription
              tied to that email.
            </p>

            {error && <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

            {phase === "login" ? (
              <div className="mt-5 space-y-4">
                <div>
                  <label htmlFor="email" className="mb-1 block text-sm font-medium text-gray-700">Email address</label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
                <Turnstile onVerify={setCaptcha} onExpire={() => setCaptcha("")} resetSignal={captchaReset} />
                <button
                  onClick={sendCode}
                  disabled={loading || !emailValid || (TURNSTILE_ENABLED && !captcha)}
                  className="w-full rounded-lg bg-gray-900 py-2.5 font-medium text-white transition hover:bg-black disabled:opacity-50"
                >
                  {loading ? "Sending…" : "Send code"}
                </button>
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <div>
                  <label htmlFor="code" className="mb-1 block text-sm font-medium text-gray-700">6-digit code</label>
                  <input
                    id="code"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="123456"
                    className="w-40 rounded-lg border border-gray-200 px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
                <button
                  onClick={verify}
                  disabled={loading || code.trim().length !== 6}
                  className="w-full rounded-lg bg-gray-900 py-2.5 font-medium text-white transition hover:bg-black disabled:opacity-50"
                >
                  {loading ? "Verifying…" : "View my subscriptions"}
                </button>
                <button onClick={() => { setPhase("login"); setCode(""); setError(""); }} className="text-sm font-medium text-brand-700 hover:underline">
                  Use a different email
                </button>
              </div>
            )}
          </div>
        )}

        {phase === "list" && (() => {
          const selected = subs.find((x) => x.id === selectedId) ?? subs[0] ?? null;
          const needing = subs.filter(needsReauthorization);
          const activeCount = subs.filter((x) => !needsReauthorization(x) && x.status !== "past_due").length;
          const intervals = new Set(subs.map((x) => x.plan.interval));
          const uniform = intervals.size === 1 ? [...intervals][0] : null;
          const maxTotal = subs.reduce((n, x) => n + x.plan.amount, 0);
          const merchants = new Set(subs.map((x) => x.merchant.name)).size;

          return (
          <div>
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <h1 className="m-0 text-4xl font-bold tracking-tight text-gray-900">Subscriptions</h1>
                <p className="m-0 mt-1.5 text-sm text-gray-500">
                  {subs.length === 0
                    ? "Nothing active on this email."
                    : `${subs.length} subscription${subs.length === 1 ? "" : "s"} with ${merchants} merchant${merchants === 1 ? "" : "s"}, paid in USDC from your own wallets.`}
                </p>
              </div>

              {subs.length > 0 && (
                <div className="flex border border-gray-900">
                  <Kpi label="Active" value={String(activeCount)} />
                  <Kpi label="Needs you" value={String(needing.length)} accent={needing.length > 0} />
                  <Kpi
                    label={uniform ? `${INTERVAL_NOUN[uniform] ?? uniform} max` : "Max / period"}
                    value={fmtUsdc(maxTotal)}
                    unit="USDC"
                  />
                </div>
              )}
            </div>

            {/* One line, above everything, naming the subscription that is not
                being collected. A paused subscription is invisible otherwise:
                nothing fails, no payment is declined, it simply stops. */}
            {needing.length > 0 && (
              <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-l-[3px] border-brand-600 bg-brand-50 px-4 py-3">
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand-700">Action needed</span>
                <p className="m-0 flex-1 text-sm text-gray-700">
                  {needing.length === 1
                    ? `${needing[0]!.merchant.name} raised ${needing[0]!.plan.name} to ${fmtUsdc(needing[0]!.plan.amount)} USDC ${INTERVAL_LABELS[needing[0]!.plan.interval] ?? ""}. Charges are paused until you approve.`
                    : `${needing.length} subscriptions are paused until you approve a new price.`}
                </p>
                {needing.length === 1 && needing[0]!.id !== selected?.id && (
                  <button onClick={() => setSelectedId(needing[0]!.id)} className="text-sm font-semibold text-brand-700 hover:underline">
                    Review &rarr;
                  </button>
                )}
              </div>
            )}

            {notice && <p className="mt-6 border-l-[3px] border-brand-600 bg-brand-50 px-4 py-3 text-sm text-brand-800">{notice}</p>}
            {error && <p className="mt-6 border-l-[3px] border-red-500 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

            {subs.length === 0 ? (
              <div className="mt-6 border border-gray-200 bg-white p-10 text-center">
                <p className="m-0 text-sm text-gray-500">No active subscriptions found for this email.</p>
              </div>
            ) : (
              <div className="mt-6 grid grid-cols-1 border border-gray-200 bg-white lg:grid-cols-[260px_1fr]">
                {/* The list. Every subscription stays one click away, which is
                    the whole reason for a two-pane layout: someone paying three
                    merchants should not scroll past two to reach the third. */}
                <aside className="border-b border-gray-200 bg-gray-50 lg:border-b-0 lg:border-r">
                  <p className="m-0 border-b border-gray-200 px-4 py-3 text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400">
                    All subscriptions · {subs.length}
                  </p>
                  {subs.map((x) => {
                    const on = x.id === selected?.id;
                    return (
                      <button
                        key={x.id}
                        onClick={() => { setSelectedId(x.id); setError(""); setNotice(""); }}
                        aria-current={on ? "true" : undefined}
                        className={`block w-full border-b border-gray-200 px-4 py-3 text-left transition ${
                          on ? "border-l-[3px] border-l-brand-600 bg-white" : "border-l-[3px] border-l-transparent hover:bg-white"
                        }`}
                      >
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[10.5px] font-bold uppercase tracking-[0.12em] text-gray-400">
                            {x.merchant.name}
                          </span>
                          <StatusChip sub={x} />
                        </span>
                        <span className="mt-1 flex items-baseline justify-between gap-2">
                          <span className="truncate font-bold text-gray-900">{x.plan.name}</span>
                          <span className="shrink-0 text-sm text-gray-500">
                            <strong className="text-gray-900">{fmtUsdc(x.plan.amount)}</strong>{" "}
                            {INTERVAL_LABELS[x.plan.interval] ?? ""}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </aside>

                {selected && (
                  <SubscriptionDetail
                    key={selected.id}
                    sub={selected}
                    supportedChains={supportedChains}
                    connected={address}
                    busyId={busyId}
                    onGrantChain={onGrantChain}
                    onRevokeGrant={onRevokeGrant}
                    onApprovePrice={onEnableGrant}
                    onCancel={onCancel}
                    onConnect={() => openConnectModal?.()}
                  />
                )}
              </div>
            )}

            <p className="mx-auto mt-6 max-w-xl text-center text-[11px] leading-relaxed text-gray-400">
              Cancelling and turning chains off cost no gas — Sweep Console covers it. Either one stops future
              charges immediately. The permission you signed stays in your wallet until you remove it there.
              Sweep Console never holds your funds.
            </p>
          </div>
          );
        })()}

      </main>
    </div>
  );
}

/**
 * One subscription, in full.
 *
 * Split out rather than inlined because it is the whole screen: the price, the
 * thing blocking it, where it charges from, what it has charged, and how to
 * stop it. Keeping it in the page body put four hundred lines inside a `.map`.
 */
function SubscriptionDetail({
  sub, supportedChains, connected, busyId,
  onGrantChain, onRevokeGrant, onApprovePrice, onCancel, onConnect,
}: {
  sub: PortalSubscription;
  supportedChains: PortalSupportedChain[];
  connected: string | undefined;
  busyId: string | null;
  onGrantChain: (s: PortalSubscription, chainId: number) => void | Promise<void>;
  onRevokeGrant: (s: PortalSubscription, chainId?: number, isLast?: boolean) => void | Promise<void>;
  onApprovePrice: (s: PortalSubscription) => void | Promise<void>;
  onCancel: (s: PortalSubscription) => void | Promise<void>;
  onConnect: () => void;
}) {
  const per = PER_NOUN[sub.plan.interval] ?? sub.plan.interval;
  const attention = needsReauthorization(sub);
  const mine = walletMatches(connected, sub.wallet_address);
  const cap = sub.grants.reduce((m, g) => (g.period_amount > m ? g.period_amount : m), 0);
  const granted = new Map(sub.grants.map((g) => [g.chain_id, g]));
  const busyWhole = busyId === sub.id;

  // Only chains this subscription could actually use. Falls back to whatever it
  // already has grants on, so a chain dropped from SUPPORTED_SOURCE_CHAINS after
  // someone authorized it still appears — they are still carrying it.
  const rows = supportedChains.length > 0
    ? supportedChains
    : sub.grants.map((g) => ({ chain_id: g.chain_id, chain_key: g.chain, name: CHAIN_NAMES[g.chain] ?? g.chain }));

  return (
    <div className="min-w-0">
      {/* Identity and price. The number is the largest thing here because it is
          the one fact a subscriber opens this page to check. */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 px-6 py-5">
        <div className="min-w-0">
          <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.12em] text-gray-400">{sub.merchant.name}</p>
          <h2 className="m-0 mt-1 truncate text-3xl font-bold tracking-tight text-gray-900">{sub.plan.name}</h2>
          <span className="mt-2 inline-block"><StatusChip sub={sub} /></span>
        </div>
        <div className="shrink-0 text-right">
          <p className="m-0 text-4xl font-bold leading-none tracking-tight text-gray-900">{fmtUsdc(sub.plan.amount)}</p>
          <p className="m-0 mt-1 text-xs text-gray-500">{sub.plan.currency} per {per}</p>
        </div>
      </div>

      {/* The block that explains a paused subscription. It leads with the two
          numbers, because "5 → 12" is the whole story and the paragraph is only
          there to say what to do about it. */}
      {attention && (
        <div className="border-b border-gray-200 bg-brand-50 px-6 py-5">
          <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.12em] text-brand-700">
            Price change · approval required
          </p>
          <p className="m-0 mt-2 text-2xl font-bold tracking-tight text-gray-900">
            <span className="text-gray-400">{fmtUsdc(cap)}</span>
            <span className="mx-2 text-gray-400">&rarr;</span>
            {fmtUsdc(sub.plan.amount)} {sub.plan.currency} / {per}
          </p>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <p className="m-0 max-w-md text-sm leading-relaxed text-gray-700">
              You authorized up to {fmtUsdc(cap)} {sub.plan.currency}, so charges are paused and you
              haven&apos;t been billed the new price. Approve to continue, or cancel.
            </p>
            <div className="shrink-0">
              {mine ? (
                <button
                  onClick={() => void onApprovePrice(sub)}
                  disabled={busyWhole}
                  className="flex items-center gap-2 bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
                >
                  {busyWhole && <Spinner size={14} tone="onAccent" />}
                  {busyWhole ? "Approving…" : `Approve ${fmtUsdc(sub.plan.amount)} ${sub.plan.currency} / ${per}`}
                </button>
              ) : (
                <>
                  <button
                    onClick={onConnect}
                    className="bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
                  >
                    Switch to {shortAddr(sub.wallet_address)}
                  </button>
                  <p className="m-0 mt-2 max-w-xs text-[11px] text-gray-500">
                    {connected
                      ? `You're connected as ${shortAddr(connected)}. Only the paying wallet can approve.`
                      : "Connect the paying wallet to approve."}
                  </p>
                </>
              )}
            </div>
          </div>
          {busyWhole && <ActivityBar className="mt-4" />}
        </div>
      )}

      <div className="grid grid-cols-2 border-b border-gray-200 sm:grid-cols-4">
        <Stat
          label="Next charge"
          value={attention ? "Paused" : sub.trial_end && new Date(sub.trial_end) > new Date() ? `Trial ends ${fmtDate(sub.trial_end)}` : fmtDate(sub.current_period_end)}
          accent={attention}
        />
        <Stat label={`${INTERVAL_NOUN[sub.plan.interval] ?? ""} limit`} value={cap > 0 ? `${fmtUsdc(cap)} ${sub.plan.currency}` : "None authorized"} />
        <Stat label="Pays from" value={<span className="font-mono text-[12.5px]">{shortAddr(sub.wallet_address)}</span>} />
        <Stat label="Started" value={fmtDate(sub.created_at)} />
      </div>

      {/* Per chain, not one switch. Renewals try each authorized chain in turn,
          so which ones are on is a real choice with a real consequence, and the
          old all-or-nothing toggle hid it. */}
      {TIER2_ENABLED && (
        <div className="border-b border-gray-200 px-6 py-5">
          <p className="m-0">
            <strong className="text-[15px] text-gray-900">Charge from</strong>{" "}
            <span className="text-xs text-gray-500">If one chain is short, we try the next. Changes are free.</span>
          </p>

          <div className="mt-3">
            {rows.map((c) => {
              const g = granted.get(c.chain_id);
              const Logo = CHAIN_LOGOS[c.chain_key];
              const rowBusy = busyId === `${sub.id}:${c.chain_id}`;
              const isLast = !!g && sub.grants.length === 1;
              return (
                <div key={c.chain_id} className="relative flex items-center gap-3 border-t border-gray-100 py-3">
                  {Logo ? <Logo className="h-5 w-5 shrink-0" /> : <span className="h-5 w-5 shrink-0 rounded-full bg-gray-200" />}
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold text-gray-900">{c.name}</span>
                    <span className="block text-xs text-gray-500">
                      {g ? `up to ${fmtUsdc(g.period_amount)} ${sub.plan.currency} a period` : "Not used for this subscription"}
                    </span>
                  </span>

                  {rowBusy ? (
                    <span className="flex items-center gap-2 text-xs text-gray-500">
                      <Spinner size={13} />
                      Confirm in your wallet…
                    </span>
                  ) : g ? (
                    <button
                      onClick={() => void onRevokeGrant(sub, c.chain_id, isLast)}
                      className="flex shrink-0 items-center gap-2 text-xs text-gray-500 hover:text-gray-900"
                      aria-label={`Turn off ${c.name}`}
                    >
                      On
                      <span className="relative block h-5 w-9 bg-gray-900 transition">
                        <span className="absolute right-0.5 top-0.5 block h-4 w-4 bg-white" />
                      </span>
                    </button>
                  ) : (
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="text-[11px] text-gray-400">Not granted</span>
                      <button
                        onClick={() => (mine ? void onGrantChain(sub, c.chain_id) : onConnect())}
                        className="border border-gray-900 px-3 py-1.5 text-xs font-semibold text-gray-900 transition hover:bg-gray-900 hover:text-white"
                      >
                        {mine ? "Grant · 1 signature" : "Switch wallet to grant"}
                      </button>
                    </span>
                  )}
                  {rowBusy && <ActivityBar className="absolute inset-x-0 bottom-0" />}
                </div>
              );
            })}
          </div>

          <p className="m-0 mt-3 max-w-lg text-[11px] leading-relaxed text-gray-500">
            {mine
              ? "Granting a new chain takes one signature from your wallet, with gas covered. Turning a granted chain off or on afterwards is free."
              : `Granting a chain needs one signature from ${shortAddr(sub.wallet_address)}${connected ? ` — you're connected as ${shortAddr(connected)}` : ""}.`}
          </p>
        </div>
      )}

      {/* What has actually been taken.
          The chain column is the one honest difficulty here. Payment.chain holds
          the SOURCE chain for a first payment and the literal "arc" for a
          renewal, so the stored value answers two different questions depending
          on the row. txHash, by contrast, is always the Arc settlement — checked
          against both chains — so the receipt link is reliable even where the
          chain label is thin. Hence "Chain", and a caption rather than a claim. */}
      <div className="border-b border-gray-200 px-6 py-5">
        <p className="m-0 text-[15px] font-bold text-gray-900">Payment history</p>
        {sub.payments.length === 0 ? (
          <p className="m-0 mt-2 text-sm text-gray-500">Nothing charged yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400">
                  <th className="border-b border-gray-200 py-2 pr-4 text-left font-bold">Date</th>
                  <th className="border-b border-gray-200 px-4 py-2 text-left font-bold">Amount</th>
                  <th className="border-b border-gray-200 px-4 py-2 text-left font-bold">Chain</th>
                  <th className="border-b border-gray-200 px-4 py-2 text-left font-bold">Status</th>
                  <th className="border-b border-gray-200 py-2 pl-4 text-right font-bold">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {sub.payments.map((pay) => (
                  <tr key={pay.id}>
                    <td className="border-b border-gray-100 py-2.5 pr-4 text-gray-600">{fmtDate(pay.created_at)}</td>
                    <td className="border-b border-gray-100 px-4 py-2.5 font-bold text-gray-900">
                      {formatUnits(BigInt(pay.amount), 6)} {pay.currency}
                    </td>
                    <td className="border-b border-gray-100 px-4 py-2.5 text-gray-600">
                      {CHAIN_NAMES[pay.settled_on] ?? pay.settled_on}
                    </td>
                    <td className="border-b border-gray-100 px-4 py-2.5">
                      <PaymentStatus payment={pay} />
                    </td>
                    <td className="border-b border-gray-100 py-2.5 pl-4 text-right">
                      {pay.tx_hash ? (
                        <a
                          href={`${EXPLORER}/tx/${pay.tx_hash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand-700 underline underline-offset-2 hover:no-underline"
                        >
                          ArcScan &#8599;
                        </a>
                      ) : (
                        <span className="text-gray-400">&mdash;</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="m-0 mt-3 text-[11px] text-gray-500">
              Every payment settles on Arc whichever chain it came from — each receipt opens the Arc transaction.
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5">
        <div className="min-w-0">
          <p className="m-0 text-[15px] font-bold text-gray-900">Cancel subscription</p>
          <p className="m-0 mt-1 text-xs text-gray-500">
            Stops all future charges right away. You keep access until {fmtDate(sub.current_period_end)}.
          </p>
        </div>
        <button
          onClick={() => void onCancel(sub)}
          disabled={busyWhole}
          className="flex shrink-0 items-center gap-2 border border-gray-900 px-4 py-2.5 text-sm font-semibold text-gray-900 transition hover:bg-gray-900 hover:text-white disabled:opacity-60"
        >
          {busyWhole && <Spinner size={14} tone="muted" />}
          {busyWhole ? "Cancelling…" : "Cancel subscription"}
        </button>
      </div>
    </div>
  );
}

function PaymentStatus({ payment }: { payment: PortalPayment }) {
  if (payment.status === "succeeded") {
    return <span className="border border-brand-300 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700">Paid</span>;
  }
  if (payment.status === "pending") {
    return <span className="text-[11px] text-gray-500">In flight</span>;
  }
  return (
    <span className="text-[11px]" style={{ color: "var(--color-accent)" }} title={payment.failure_reason ?? undefined}>
      {payment.status === "failed" ? "Failed" : payment.status}
    </span>
  );
}
