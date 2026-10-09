import { useState, type JSX, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAccount, useConnectorClient } from "wagmi";
import { formatUnits } from "viem";
import { Logo } from "@/components/ui/Logo";
import { CHAIN_MARKS } from "@/components/landing/ChainMarks";
import { Spinner, ActivityBar } from "@/components/ui/Spinner";
import { Turnstile, TURNSTILE_ENABLED } from "@/components/Turnstile";
import { getSupportedDelegationChainIds } from "@/lib/delegation/capabilities";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
import { friendlyError } from "@/lib/errors";
import { useWalletPicker } from "@/lib/useWalletPicker";
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
  portalRevokeMandate,
  type PortalMandate,
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

/// The design's micro-label: 10px, wide tracking, upper. Used for every column
/// heading, kicker and stat key on this page, so it is written once.
const UPPER: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--color-neutral-600)",
  margin: 0,
};
const HEADING = "var(--font-heading)";

function Kpi({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: boolean }) {
  return (
    <div style={{ padding: "10px 18px", borderLeft: "1px solid var(--color-divider)", minWidth: 110 }}>
      <p style={{ ...UPPER, marginBottom: 4 }}>{label}</p>
      <p
        style={{
          fontFamily: HEADING, fontWeight: 800, fontSize: 20, lineHeight: 1, margin: 0,
          color: accent ? "var(--color-accent)" : undefined,
        }}
      >
        {value}
        {unit && <span style={{ fontSize: 12, fontWeight: 400, color: "var(--color-neutral-700)" }}> {unit}</span>}
      </p>
    </div>
  );
}

/// What state this subscription is in, in the subscriber's terms. "Action
/// needed" outranks the stored status: a past_due row whose cap no longer covers
/// the price is not a failed payment, it is a price waiting on a signature.
function statusOf(sub: PortalSubscription): { label: string; cls: string } {
  if (needsReauthorization(sub)) return { label: "Action needed", cls: "tag-accent" };
  if (sub.status === "trialing") return { label: "Trial", cls: "tag-outline" };
  if (sub.status === "past_due") return { label: "Past due", cls: "tag-accent" };
  return { label: "Active", cls: "tag-outline" };
}

function StatusChip({ sub, style }: { sub: PortalSubscription; style?: React.CSSProperties }) {
  const { label, cls } = statusOf(sub);
  return <span className={`tag ${cls}`} style={style}>{label}</span>;
}

/// One cell of the facts grid. The negative margin is the design's: it collapses
/// the 1px dividers so an auto-fit grid does not double them at the wrap.
function Fact({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div
      style={{
        padding: "16px 22px",
        borderLeft: "1px solid var(--color-divider)",
        borderTop: "1px solid var(--color-divider)",
        margin: "-1px 0 0 -1px",
      }}
    >
      <p style={{ ...UPPER, marginBottom: 6 }}>{label}</p>
      <p style={{ fontSize: 14, margin: 0, fontFamily: mono ? "ui-monospace, Menlo, monospace" : undefined, wordBreak: "break-all" }}>
        {value}
      </p>
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
  /// Not useConnectModal directly: that opener is undefined once a wallet is
  /// connected, which is precisely when this page needs it. See useWalletPicker.
  const pickWallet = useWalletPicker();

  const [phase, setPhase] = useState<Phase>("login");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailToken, setEmailToken] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);

  const [subs, setSubs] = useState<PortalSubscription[]>([]);
  // Rail mandates against this same proved address. Shown, not managed: the
  // developer owns the schedule, and the only way to end one is to disable the
  // delegation in the wallet that signed it.
  const [mandates, setMandates] = useState<PortalMandate[]>([]);
  const [confirmMandate, setConfirmMandate] = useState<PortalMandate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  /// Which subscription the detail pane shows. Null until the list arrives.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [supportedChains, setSupportedChains] = useState<PortalSupportedChain[]>([]);
  /// The subscription a cancel has been asked about. window.confirm() was doing
  /// this job, which on a page that otherwise looks like this read as the
  /// browser interrupting rather than the product asking.
  const [confirmCancel, setConfirmCancel] = useState<PortalSubscription | null>(null);

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
      setMandates(res.mandates ?? []);
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
    // The list is scoped to pending and active, so a mandate just turned off
    // leaves it here. Missing this is what left a dead row on screen with a
    // live Cancel on it, under a notice saying it had worked.
    setMandates(res.mandates ?? []);
    if (res.supported_chains) setSupportedChains(res.supported_chains);
    // Keep the open subscription open. Without this a cancel or a grant drops
    // the reader back to the top of a list they were working inside.
    setSelectedId((cur) => (cur && res.subscriptions.some((x) => x.id === cur) ? cur : res.subscriptions[0]?.id ?? null));
  };

  const onCancel = async (s: PortalSubscription) => {
    setConfirmCancel(null);
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

  const onRevokeMandate = async (m: PortalMandate) => {
    setConfirmMandate(null);
    setBusyId(m.mandate_id);
    setError("");
    setNotice("");
    try {
      await portalRevokeMandate(email.trim(), emailToken, m.mandate_id);
      setNotice(
        `${m.merchant.name} can no longer charge you. The permission you signed stays in your ` +
          `wallet until you remove it there — we simply will not redeem it.`
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
      pickWallet();
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
      pickWallet();
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
    if (!address || !connectorClient) return pickWallet();
    if (!walletMatches(address, s.wallet_address)) {
      setError(
        `This subscription pays from ${shortAddr(s.wallet_address)}. You're connected as ` +
          `${shortAddr(address)} — switch to that wallet, because only the wallet that signed up can ` +
          `approve charges for it.`
      );
      pickWallet();
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
    <div style={{ minHeight: "100vh", fontFamily: "var(--font-body)", display: "flex", flexDirection: "column", background: "var(--color-bg)" }}>
      <header style={{ borderBottom: "2px solid var(--color-text)" }}>
        <div
          style={{
            maxWidth: 1160, margin: "0 auto", padding: "0 32px", height: 60,
            display: "flex", alignItems: "center", gap: 16,
          }}
        >
          <Link to="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "inherit" }}>
            <Logo height={22} />
            <span style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 15, letterSpacing: "-0.01em" }}>
              Sweep Console
            </span>
          </Link>
          <span style={{ width: 1, height: 20, background: "var(--color-divider)" }} />
          <span style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>Customer portal</span>

          {phase === "list" ? (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
              <span className="hidden sm:inline" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
                {email.trim()}
              </span>
              {/* Which wallet is connected decides half the controls below —
                  whether a chain can be granted, whether a price can be
                  approved — so it belongs in the chrome, not in a row's error
                  text after the click. */}
              <button
                onClick={() => pickWallet()}
                title={address ? "Switch wallet" : "Connect wallet"}
                style={{
                  display: "flex", alignItems: "center", gap: 9,
                  border: "2px solid var(--color-text)", background: "var(--color-bg)",
                  padding: "6px 12px", cursor: "pointer", fontFamily: "var(--font-body)",
                  color: "var(--color-text)",
                }}
              >
                <span style={{ width: 8, height: 8, background: address ? "var(--color-accent)" : "var(--color-neutral-400)", display: "block" }} />
                <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>
                  {address ? shortAddr(address) : "No wallet"}
                </span>
                <span style={{ fontSize: 11, color: "var(--color-neutral-600)", borderLeft: "1px solid var(--color-divider)", paddingLeft: 9 }}>
                  {address ? "Switch" : "Connect"}
                </span>
              </button>
            </div>
          ) : (
            <Link to="/" style={{ marginLeft: "auto", fontSize: 13, color: "var(--color-neutral-700)" }}>
              Home
            </Link>
          )}
        </div>
      </header>

      <main
        style={
          phase === "list"
            ? { flex: 1, maxWidth: 1160, width: "100%", margin: "0 auto", padding: "40px 32px 64px", boxSizing: "border-box" }
            : { flex: 1, maxWidth: 672, width: "100%", margin: "0 auto", padding: "48px 24px" }
        }
      >
        {phase !== "list" && (
          <div className="mx-auto max-w-md" style={{ border: "2px solid var(--color-text)", background: "var(--color-bg)", padding: 32 }}>
            <h1 style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 26, letterSpacing: "-0.02em", margin: 0 }}>Manage your subscriptions</h1>
            <p style={{ fontSize: 13.5, color: "var(--color-neutral-700)", margin: "8px 0 0", lineHeight: 1.6 }}>
              Enter your email and we&apos;ll send a 6-digit code. You&apos;ll see every subscription
              tied to that email.
            </p>

            {error && <p style={{ marginTop: 16, padding: "12px 16px", background: "var(--color-accent-100)", borderLeft: "3px solid var(--color-accent)", fontSize: 13 }}>{error}</p>}

            {phase === "login" ? (
              <div className="mt-5 space-y-4">
                <div>
                  <label htmlFor="email" className="block" style={{ ...UPPER, marginBottom: 6 }}>Email address</label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="input" style={{ width: "100%" }}
                  />
                </div>
                <Turnstile onVerify={setCaptcha} onExpire={() => setCaptcha("")} resetSignal={captchaReset} />
                <button
                  onClick={sendCode}
                  disabled={loading || !emailValid || (TURNSTILE_ENABLED && !captcha)}
                  className="btn btn-primary" style={{ width: "100%" }}
                >
                  {loading ? "Sending…" : "Send code"}
                </button>
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <div>
                  <label htmlFor="code" className="block" style={{ ...UPPER, marginBottom: 6 }}>6-digit code</label>
                  <input
                    id="code"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="123456"
                    className="input" style={{ width: 160, fontVariantNumeric: "tabular-nums" }}
                  />
                </div>
                <button
                  onClick={verify}
                  disabled={loading || code.trim().length !== 6}
                  className="btn btn-primary" style={{ width: "100%" }}
                >
                  {loading ? "Verifying…" : "View my subscriptions"}
                </button>
                <button onClick={() => { setPhase("login"); setCode(""); setError(""); }} className="btn btn-ghost" style={{ padding: 0, fontSize: 13 }}>
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
          const first = needing[0];

          return (
          <>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 24 }}>
              <div>
                <h1 style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 44, lineHeight: 1, letterSpacing: "-0.035em", margin: "0 0 8px" }}>
                  Subscriptions
                </h1>
                <p style={{ fontSize: 14, color: "var(--color-neutral-700)", margin: 0 }}>
                  {subs.length === 0
                    ? "Nothing active on this email."
                    : `${subs.length} subscription${subs.length === 1 ? "" : "s"} with ${merchants} merchant${merchants === 1 ? "" : "s"}, paid in USDC from your own wallets.`}
                </p>
              </div>
              {subs.length > 0 && (
                <div style={{ marginLeft: "auto", display: "flex", border: "2px solid var(--color-text)" }}>
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

            {/* One strip, above everything, naming the subscription that is not
                being collected. A paused subscription is invisible otherwise:
                nothing fails, no payment is declined, it simply stops. */}
            {first && (
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 14, padding: "14px 20px",
                  background: "var(--color-accent-100)", borderTop: "2px solid var(--color-accent)",
                  borderBottom: "1px solid var(--color-accent-300)", marginBottom: 28, flexWrap: "wrap",
                }}
              >
                <span className="tag tag-accent">Action needed</span>
                <span style={{ fontSize: 13.5, color: "var(--color-accent-900)" }}>
                  {needing.length === 1
                    ? `${first.merchant.name} raised ${first.plan.name} to ${fmtUsdc(first.plan.amount)} ${first.plan.currency} / ${PER_NOUN[first.plan.interval] ?? first.plan.interval}. Charges are paused until you approve.`
                    : `${needing.length} subscriptions are paused until you approve a new price.`}
                </span>
                {first.id !== selected?.id && (
                  <button
                    className="btn btn-ghost"
                    style={{ marginLeft: "auto", fontSize: 13, padding: 0, color: "var(--color-accent-700)" }}
                    onClick={() => { setSelectedId(first.id); setError(""); setNotice(""); }}
                  >
                    Review &rarr;
                  </button>
                )}
              </div>
            )}

            {notice && (
              <div style={{ padding: "12px 18px", background: "var(--color-accent-100)", borderLeft: "3px solid var(--color-accent)", marginBottom: 20, fontSize: 13 }}>
                {notice}
              </div>
            )}
            {error && (
              <div style={{ padding: "12px 18px", background: "var(--color-neutral-100)", borderLeft: "3px solid var(--color-accent)", marginBottom: 20, fontSize: 13 }}>
                {error}
              </div>
            )}

            {subs.length === 0 ? (
              <div style={{ border: "2px solid var(--color-text)", padding: 40, textAlign: "center" }}>
                <p style={{ fontSize: 13, color: "var(--color-neutral-700)", margin: 0 }}>
                  No active subscriptions found for this email.
                </p>
              </div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", border: "2px solid var(--color-text)" }}>
                {/* The list. Every subscription stays one click away, which is
                    the point of two panes: someone paying three merchants should
                    not scroll past two to reach the third. */}
                <nav
                  aria-label="Your subscriptions"
                  style={{ flex: "1 1 280px", maxWidth: "100%", borderRight: "1px solid var(--color-divider)", background: "var(--color-surface)" }}
                >
                  <p style={{ ...UPPER, padding: "14px 20px", borderBottom: "2px solid var(--color-text)" }}>
                    All subscriptions · {subs.length}
                  </p>
                  {subs.map((x) => {
                    const on = x.id === selected?.id;
                    return (
                      <button
                        key={x.id}
                        onClick={() => { setSelectedId(x.id); setError(""); setNotice(""); }}
                        aria-current={on ? "true" : undefined}
                        style={{
                          display: "block", width: "100%", textAlign: "left",
                          background: on ? "var(--color-bg)" : "transparent",
                          border: 0, borderBottom: "1px solid var(--color-divider)",
                          borderLeft: `4px solid ${on ? "var(--color-accent)" : "transparent"}`,
                          padding: "16px 20px 16px 16px", cursor: "pointer",
                          fontFamily: "var(--font-body)", color: "var(--color-text)",
                        }}
                      >
                        <span style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                          <span style={{ ...UPPER, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {x.merchant.name}
                          </span>
                          <StatusChip sub={x} style={{ marginLeft: "auto" }} />
                        </span>
                        <span style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                          <span style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 16, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {x.plan.name}
                          </span>
                          <span style={{ marginLeft: "auto", fontFamily: HEADING, fontWeight: 800, fontSize: 15, whiteSpace: "nowrap" }}>
                            {fmtUsdc(x.plan.amount)}
                            <span style={{ fontSize: 11.5, fontWeight: 400, color: "var(--color-neutral-700)" }}>
                              {" "}/{PER_NOUN[x.plan.interval] ?? x.plan.interval}
                            </span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </nav>

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
                    onAskCancel={(x) => setConfirmCancel(x)}
                    onConnect={() => pickWallet()}
                  />
                )}
              </div>
            )}

            <p style={{ fontSize: 12, lineHeight: 1.65, color: "var(--color-neutral-700)", margin: "22px 0 0", maxWidth: "80ch" }}>
              Cancelling and turning chains off cost no gas — Sweep Console covers it. Either one stops future
              charges immediately. The permission you signed stays in your wallet until you remove it there.
              Sweep Console never holds your funds.
            </p>
          </>
          );
        })()}

        {/* Standing authorizations from the external rail.
            Separate from subscriptions on purpose: there is no schedule here
            that Sweep owns. A developer charges when they choose, up to the
            ceiling, so the honest thing to show is the ceiling, what has
            actually been taken, and who can stop it — which is only the wallet
            that signed. These appeared nowhere until the rail started proving
            the payer's email; before that there was no verified address to
            match them to. */}
        {mandates.length > 0 && (
          <section style={{ marginTop: 40 }}>
            <p style={{ ...UPPER, marginBottom: 10 }}>Standing authorizations</p>
            <div style={{ borderTop: "1px solid var(--color-divider)" }}>
              {mandates.map((m) => (
                <div
                  key={m.mandate_id}
                  style={{
                    padding: "14px 0",
                    borderBottom: "1px solid var(--color-divider)",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "baseline",
                    gap: 12,
                  }}
                >
                  <span style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 14.5 }}>
                    {m.merchant.name}
                  </span>
                  <span className={`tag ${m.status === "active" ? "tag-outline" : "tag-neutral"}`}>
                    {m.status === "active" ? "Authorized" : m.status}
                  </span>
                  {m.test_mode && <span className="tag tag-neutral">Test</span>}
                  <span style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
                    up to {fmtUsdc(m.max_amount)} {m.currency} a {PER_NOUN[m.interval] ?? m.interval}
                    {m.chains.length > 0 && ` · ${m.chains.length} chain${m.chains.length > 1 ? "s" : ""}`}
                    {m.charges.length > 0 && ` · ${m.charges.length} charge${m.charges.length > 1 ? "s" : ""}`}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 12,
                      color: "var(--color-neutral-700)",
                      fontFamily: "ui-monospace, Menlo, monospace",
                    }}
                  >
                    {m.wallet_address ? shortAddr(m.wallet_address) : "unsigned"}
                  </span>
                  <button
                    className="btn btn-secondary"
                    style={{ flex: "none" }}
                    disabled={busyId === m.mandate_id}
                    onClick={() => setConfirmMandate(m)}
                  >
                    {busyId === m.mandate_id ? "Cancelling…" : "Cancel"}
                  </button>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 12, lineHeight: 1.65, color: "var(--color-neutral-700)", margin: "12px 0 0", maxWidth: "80ch" }}>
              These were authorized directly with the merchant rather than through a Sweep Console plan:
              they charge when they choose, never above the ceiling shown. Cancelling one stops Sweep
              Console redeeming it and tells the merchant straight away. The permission you signed stays
              in your wallet until you remove it there.
            </p>
          </section>
        )}

      </main>

      {confirmMandate && (
        <div className="dialog-backdrop" onClick={() => setConfirmMandate(null)}>
          <div
            className="dialog"
            style={{ border: "2px solid var(--color-text)", maxWidth: 460 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <p className="dialog-title" style={{ margin: 0 }}>
              Cancel {confirmMandate.merchant.name}?
            </p>
            <p className="dialog-body" style={{ margin: 0 }}>
              They will not be able to charge you again, and they are told straight away. Charges
              already taken are not reversed. The permission you signed stays in your wallet until you
              remove it there — cancelling here means we will not redeem it.
            </p>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmMandate(null)}>
                Keep it
              </button>
              <button className="btn btn-primary" onClick={() => void onRevokeMandate(confirmMandate)}>
                Cancel it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Asking before an irreversible thing, in the product's own voice. */}
      {confirmCancel && (
        <div className="dialog-backdrop" onClick={() => setConfirmCancel(null)}>
          <div
            className="dialog"
            style={{ border: "2px solid var(--color-text)", maxWidth: 460 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <p className="dialog-title" style={{ margin: 0 }}>Cancel {confirmCancel.plan.name}?</p>
            <p className="dialog-body" style={{ margin: 0 }}>
              {confirmCancel.merchant.name} won&apos;t be able to charge you again. You keep access until{" "}
              {fmtDate(confirmCancel.current_period_end)}. Charges already taken are not reversed.
            </p>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmCancel(null)}>Keep subscription</button>
              <button className="btn btn-primary" onClick={() => void onCancel(confirmCancel)}>Cancel subscription</button>
            </div>
          </div>
        </div>
      )}
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
  onGrantChain, onRevokeGrant, onApprovePrice, onAskCancel, onConnect,
}: {
  sub: PortalSubscription;
  supportedChains: PortalSupportedChain[];
  connected: string | undefined;
  busyId: string | null;
  onGrantChain: (s: PortalSubscription, chainId: number) => void | Promise<void>;
  onRevokeGrant: (s: PortalSubscription, chainId?: number, isLast?: boolean) => void | Promise<void>;
  onApprovePrice: (s: PortalSubscription) => void | Promise<void>;
  onAskCancel: (s: PortalSubscription) => void;
  onConnect: () => void;
}) {
  const per = PER_NOUN[sub.plan.interval] ?? sub.plan.interval;
  const attention = needsReauthorization(sub);
  const mine = walletMatches(connected, sub.wallet_address);
  const cap = sub.grants.reduce((m, g) => (g.period_amount > m ? g.period_amount : m), 0);
  const granted = new Map(sub.grants.map((g) => [g.chain_id, g]));
  const busyWhole = busyId === sub.id;
  const trialing = !!sub.trial_end && new Date(sub.trial_end) > new Date();

  // Only chains this subscription could use. Falls back to whatever it already
  // has grants on, so a chain dropped from SUPPORTED_SOURCE_CHAINS after someone
  // authorized it still appears — they are still carrying it.
  const rows: PortalSupportedChain[] = supportedChains.length > 0
    ? supportedChains
    : sub.grants.map((g) => ({ chain_id: g.chain_id, chain_key: g.chain, name: CHAIN_NAMES[g.chain] ?? g.chain }));

  return (
    <section style={{ flex: "999 1 520px", minWidth: 0, animation: "swp-in .2s ease" }}>
      <div
        style={{
          padding: "26px 30px 22px", display: "flex", alignItems: "flex-start", gap: 20,
          flexWrap: "wrap", borderBottom: "2px solid var(--color-text)",
        }}
      >
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <p style={{ ...UPPER, letterSpacing: "0.16em", color: "var(--color-accent-700)", marginBottom: 8 }}>
            {sub.merchant.name}
          </p>
          <h2 style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 32, lineHeight: 1, letterSpacing: "-0.03em", margin: "0 0 10px" }}>
            {sub.plan.name}
          </h2>
          <StatusChip sub={sub} />
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 40, lineHeight: 1, letterSpacing: "-0.035em", margin: 0 }}>
            {fmtUsdc(sub.plan.amount)}
          </p>
          <p style={{ fontSize: 12.5, color: "var(--color-neutral-700)", margin: "4px 0 0" }}>
            {sub.plan.currency} per {per}
          </p>
        </div>
      </div>

      {/* The block that explains a paused subscription. The struck-through cap
          beside the new price is the whole story; the paragraph only says what
          to do about it. */}
      {attention && (
        <div style={{ padding: "22px 30px", background: "var(--color-accent-100)", borderBottom: "1px solid var(--color-accent-300)" }}>
          <div
            style={{
              display: "grid", gap: 20, alignItems: "end",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))",
            }}
          >
            <div>
              <p style={{ ...UPPER, letterSpacing: "0.16em", color: "var(--color-accent-700)", marginBottom: 10 }}>
                Price change · approval required
              </p>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
                <span style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 22, color: "var(--color-neutral-600)", textDecoration: "line-through" }}>
                  {fmtUsdc(cap)}
                </span>
                <span style={{ fontSize: 14, color: "var(--color-neutral-700)" }}>&rarr;</span>
                <span style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 22 }}>
                  {fmtUsdc(sub.plan.amount)} {sub.plan.currency} / {per}
                </span>
              </div>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--color-accent-900)", margin: 0, maxWidth: "52ch" }}>
                You authorized up to {fmtUsdc(cap)} {sub.plan.currency}, so charges are paused and you haven&apos;t been
                billed the new price. Approve to continue, or cancel.
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
              <button
                className="btn btn-primary"
                style={{ padding: "12px 20px", display: "flex", alignItems: "center", gap: 10 }}
                disabled={busyWhole}
                onClick={() => (mine ? void onApprovePrice(sub) : onConnect())}
              >
                {busyWhole && <Spinner size={14} tone="onAccent" />}
                {busyWhole
                  ? "Approving…"
                  : mine
                    ? `Approve ${fmtUsdc(sub.plan.amount)} ${sub.plan.currency} / ${per}`
                    : `Switch to ${shortAddr(sub.wallet_address)}`}
              </button>
              <span style={{ fontSize: 11.5, color: "var(--color-accent-800)", lineHeight: 1.5 }}>
                {mine
                  ? "One signature. Gas is covered."
                  : connected
                    ? `You're connected as ${shortAddr(connected)}. Only the paying wallet can approve.`
                    : "Connect the paying wallet to approve."}
              </span>
            </div>
          </div>
          {busyWhole && <ActivityBar className="mt-4" />}
        </div>
      )}

      <div
        style={{
          display: "grid", borderBottom: "2px solid var(--color-text)",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
        }}
      >
        <Fact
          label="Next charge"
          value={attention ? <span style={{ color: "var(--color-accent)" }}>Paused</span>
            : trialing ? `Trial ends ${fmtDate(sub.trial_end!)}`
            : fmtDate(sub.current_period_end)}
        />
        <Fact label={`${INTERVAL_NOUN[sub.plan.interval] ?? ""} limit`} value={cap > 0 ? `${fmtUsdc(cap)} ${sub.plan.currency}` : "None authorized"} />
        <Fact label="Pays from" value={shortAddr(sub.wallet_address)} mono />
        <Fact label="Started" value={fmtDate(sub.created_at)} />
      </div>

      {/* Per chain, not one switch. Renewals try each authorized chain in turn,
          so which ones are on is a real choice with a real consequence. */}
      <div style={{ padding: "22px 30px", borderBottom: "1px solid var(--color-divider)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <h3 style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 17, margin: 0, letterSpacing: "-0.01em" }}>Charge from</h3>
          <span style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
            If one chain is short, we try the next. Changes are free.
          </span>
        </div>

        <div style={{ borderTop: "1px solid var(--color-divider)" }}>
          {rows.map((c) => {
            const g = granted.get(c.chain_id);
            const Mark = CHAIN_MARKS[c.chain_key];
            const rowBusy = busyId === `${sub.id}:${c.chain_id}`;
            const isLast = !!g && sub.grants.length === 1;
            return (
              <div
                key={c.chain_id}
                style={{
                  position: "relative", display: "flex", alignItems: "center", gap: 14,
                  padding: "13px 0", borderBottom: "1px solid var(--color-divider)", flexWrap: "wrap",
                }}
              >
                {Mark
                  ? <Mark height={22} opacity={g ? 1 : 0.45} />
                  : <span style={{ width: 22, height: 22, flex: "none", background: "var(--color-neutral-200)" }} />}
                <span style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 14.5, color: g ? undefined : "var(--color-neutral-700)" }}>
                  {c.name}
                </span>
                <span style={{ fontSize: 12.5, color: "var(--color-neutral-700)" }}>
                  {g ? `up to ${fmtUsdc(g.period_amount)} ${sub.plan.currency} a period` : "Not used for this subscription"}
                </span>

                {rowBusy ? (
                  <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--color-neutral-700)" }}>
                    <Spinner size={13} />
                    Confirm in your wallet…
                  </span>
                ) : g ? (
                  <button
                    onClick={() => void onRevokeGrant(sub, c.chain_id, isLast)}
                    aria-label={`Turn off ${c.name}`}
                    style={{
                      marginLeft: "auto", display: "flex", alignItems: "center", gap: 10,
                      background: "transparent", border: 0, padding: 0, cursor: "pointer",
                      fontFamily: "var(--font-body)", fontSize: 12.5, color: "var(--color-text)",
                    }}
                  >
                    <span style={{ minWidth: 22, textAlign: "right" }}>On</span>
                    <span
                      style={{
                        width: 40, height: 22, border: "2px solid var(--color-text)",
                        background: "var(--color-text)", display: "flex", justifyContent: "flex-end",
                        boxSizing: "border-box", padding: 3,
                      }}
                    >
                      <span style={{ width: 12, height: 12, background: "var(--color-bg)", display: "block" }} />
                    </span>
                  </button>
                ) : (
                  <>
                    <span className="tag tag-neutral" style={{ marginLeft: "auto" }}>Not granted</span>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: "7px 12px", fontSize: 12.5 }}
                      onClick={() => (mine ? void onGrantChain(sub, c.chain_id) : onConnect())}
                    >
                      {mine ? "Grant · 1 signature" : "Switch wallet to grant"}
                    </button>
                  </>
                )}
                {rowBusy && <ActivityBar className="absolute inset-x-0 bottom-0" />}
              </div>
            );
          })}
        </div>

        <p style={{ fontSize: 12, lineHeight: 1.6, color: "var(--color-neutral-700)", margin: "10px 0 0", maxWidth: "70ch" }}>
          {mine
            ? "Granting a new chain takes one signature from your wallet, with gas covered. Turning a granted chain off or on afterwards is free."
            : `Granting a chain needs one signature from ${shortAddr(sub.wallet_address)}${connected ? ` — you're connected as ${shortAddr(connected)}` : ""}.`}
        </p>

        {sub.grants.length === 0 && (
          <p style={{ fontSize: 12.5, color: "var(--color-accent-800)", margin: "10px 0 0" }}>
            No chains are on, so renewals are paused until you turn one back on.
          </p>
        )}
      </div>

      {/* The chain column is the one honest difficulty here. Payment.chain holds
          the SOURCE chain for a first payment and the literal "arc" for a
          renewal, so the stored value answers two different questions depending
          on the row. txHash, by contrast, is always the Arc settlement — checked
          against both chains — so the receipt link is reliable regardless. */}
      <div style={{ padding: "22px 30px", borderBottom: "1px solid var(--color-divider)" }}>
        <h3 style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 17, margin: "0 0 12px", letterSpacing: "-0.01em" }}>
          Payment history
        </h3>
        {sub.payments.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--color-neutral-700)", margin: 0 }}>Nothing charged yet.</p>
        ) : (
          <>
            <div style={{ overflowX: "auto", maxWidth: "100%" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th><th>Amount</th><th>Chain</th><th>Status</th>
                    <th style={{ textAlign: "right" }}>Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {sub.payments.map((pay) => (
                    <tr key={pay.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDate(pay.created_at)}</td>
                      <td style={{ fontFamily: HEADING, fontWeight: 800, whiteSpace: "nowrap" }}>
                        {formatUnits(BigInt(pay.amount), 6)} {pay.currency}
                      </td>
                      <td style={{ color: "var(--color-neutral-700)" }}>{CHAIN_NAMES[pay.settled_on] ?? pay.settled_on}</td>
                      <td><PaymentStatus payment={pay} /></td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {pay.tx_hash ? (
                          <a href={`${EXPLORER}/tx/${pay.tx_hash}`} target="_blank" rel="noreferrer">ArcScan &#8599;</a>
                        ) : (
                          <span style={{ color: "var(--color-neutral-600)" }}>&mdash;</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: 12, color: "var(--color-neutral-700)", margin: "10px 0 0" }}>
              Every payment settles on Arc whichever chain it came from — each receipt opens the Arc transaction.
            </p>
          </>
        )}
      </div>

      <div style={{ padding: "20px 30px 24px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 300px" }}>
          <p style={{ fontFamily: HEADING, fontWeight: 800, fontSize: 15, margin: "0 0 4px" }}>Cancel subscription</p>
          <p style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--color-neutral-700)", margin: 0, maxWidth: "60ch" }}>
            Stops all future charges right away. You keep access until {fmtDate(sub.current_period_end)}.
          </p>
        </div>
        <button
          className="btn btn-secondary"
          style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}
          disabled={busyWhole}
          onClick={() => onAskCancel(sub)}
        >
          {busyWhole && <Spinner size={14} tone="muted" />}
          {busyWhole ? "Cancelling…" : "Cancel subscription"}
        </button>
      </div>
    </section>
  );
}

function PaymentStatus({ payment }: { payment: PortalPayment }) {
  if (payment.status === "succeeded") return <span className="tag tag-outline">Paid</span>;
  if (payment.status === "pending") return <span className="tag tag-neutral">In flight</span>;
  return (
    <span className="tag tag-accent" title={payment.failure_reason ?? undefined}>
      {payment.status === "failed" ? "Failed" : payment.status}
    </span>
  );
}
