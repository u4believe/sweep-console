import { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount, useConnectorClient } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits } from "viem";
import { Logo } from "@/components/ui/Logo";
import { Turnstile, TURNSTILE_ENABLED } from "@/components/Turnstile";
import { getSupportedDelegationChainIds } from "@/lib/delegation/capabilities";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
import {
  portalRequestOtp,
  verifyOtp,
  portalListSubscriptions,
  portalCancelSubscription,
  portalGrantPlan,
  portalSaveGrant,
  portalRevokeGrant,
  type PortalSubscription,
} from "@/lib/gateway";

// Standalone, cross-merchant customer portal. Email + OTP proves ownership; the
// customer then sees and manages every SweepConsole subscription tied to that
// email across all merchants — cancel (gasless, returns escrow) and enable/revoke
// the cross-chain renewal grant. No checkout session, no merchant context needed.

const TIER2_ENABLED = import.meta.env.VITE_TIER2_DELEGATION === "true";

/// The API sends a chain key ("base"); this is the name a person reads. Falls
/// back to the key rather than a chain id, which means nothing to a subscriber.
const CHAIN_NAMES: Record<string, string> = {
  base: "Base",
  optimism: "Optimism",
  arbitrum: "Arbitrum",
  arc: "Arc",
};

function chainLabel(chainId: number, s: PortalSubscription): string {
  const g = s.grants.find((x) => x.chain_id === chainId);
  if (!g) return "Cross-chain";
  return CHAIN_NAMES[g.chain] ?? g.chain;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INTERVAL_LABELS: Record<string, string> = {
  daily: "/ day",
  weekly: "/ week",
  monthly: "/ month",
  yearly: "/ year",
};

type Phase = "login" | "code" | "list";

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user storage|gator_7715|Failed to fetch/i.test(msg)) {
    return "MetaMask couldn't reach its permission storage. Turn on Settings → Backup and sync, make sure you're signed in and online, then try again.";
  }
  if (/rejected|denied|cancell?ed/i.test(msg)) return "Request cancelled.";
  return msg || "Something went wrong. Please try again.";
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
      setPhase("list");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  };

  const reload = async () => {
    const res = await portalListSubscriptions(email.trim(), emailToken).catch(() => null);
    if (res) setSubs(res.subscriptions);
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
      await grantRenewalMandates(address, usable, (input) =>
        portalSaveGrant(email.trim(), emailToken, s.id, input)
      );
      setNotice("Cross-chain renewals enabled. Renewals can now fall back to your USDC on other chains.");
      await reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  };

  const onRevokeGrant = async (s: PortalSubscription, chainId?: number) => {
    // Busy is keyed per chain so turning off Base does not grey out Optimism's
    // button next to it.
    setBusyId(chainId === undefined ? s.id : `${s.id}:${chainId}`);
    setError("");
    setNotice("");
    try {
      await portalRevokeGrant(email.trim(), emailToken, s.id, chainId);
      // Says what this actually did. Revoking here stops US redeeming the mandate;
      // it cannot remove the permission from the subscriber's wallet, because
      // disableDelegation is onlyDeleGator. Claiming otherwise left people
      // believing an authorization was gone while it was still signed and live.
      const where = chainId === undefined ? "Cross-chain renewals" : `${chainLabel(chainId, s)} renewals`;
      setNotice(
        `${where} turned off — we won't charge ${chainId === undefined ? "those chains" : "that chain"} again. ` +
          "Your subscription stays active and bills on Arc. The permission you signed stays in your wallet " +
          "until you revoke it there."
      );
      await reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  };

  // Group subscriptions by merchant for a clean, scannable list.
  const byMerchant = subs.reduce<Record<string, PortalSubscription[]>>((acc, s) => {
    (acc[s.merchant.name] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header className="flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo height={28} />
          <span className="text-lg font-bold tracking-tight text-gray-900">Sweep Console</span>
          <span className="ml-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">Manage</span>
        </Link>
        <Link to="/" className="text-sm font-medium text-gray-600 transition hover:text-gray-900">Home</Link>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
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

        {phase === "list" && (
          <div>
            <div className="mb-6 flex items-baseline justify-between">
              <h1 className="text-2xl font-bold text-gray-900">Your subscriptions</h1>
              <span className="text-sm text-gray-500">{email.trim()}</span>
            </div>

            {notice && <p className="mb-4 rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-700">{notice}</p>}
            {error && <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

            {subs.length === 0 ? (
              <div className="rounded-2xl border border-gray-100 bg-white p-10 text-center shadow-sm">
                <p className="text-sm text-gray-500">No active subscriptions found for this email.</p>
              </div>
            ) : (
              <div className="space-y-8">
                {Object.entries(byMerchant).map(([merchant, items]) => (
                  <section key={merchant}>
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">{merchant}</h2>
                    <div className="space-y-3">
                      {items.map((s) => {
                        const busy = busyId === s.id;
                        return (
                          <div key={s.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-gray-900">
                                  {s.plan.name}
                                  {s.status !== "active" && (
                                    <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-gray-500">{s.status}</span>
                                  )}
                                </p>
                                <p className="text-xs text-gray-500">
                                  ${formatUnits(BigInt(s.plan.amount), 6)} {s.plan.currency} {INTERVAL_LABELS[s.plan.interval] ?? ""}
                                </p>
                                {s.trial_end && new Date(s.trial_end) > new Date() && (
                                  <p className="mt-1 text-[11px] font-medium text-brand-600">Trial ends {new Date(s.trial_end).toLocaleDateString()}</p>
                                )}
                                {s.escrow_refundable && s.refundable_until && (
                                  <p className="mt-1 text-[11px] text-amber-600">
                                    Refundable until {new Date(s.refundable_until).toLocaleString()} — cancel before then to get your first payment back.
                                  </p>
                                )}
                                <p className="mt-1 break-all font-mono text-[11px] text-gray-400">{s.wallet_address}</p>
                                <p className="text-[11px] text-gray-400">
                                  {s.permissions.arc_subscription ? "Arc renewals on" : "No on-chain subscription"}
                                  {s.cross_chain_enabled ? ` · ${s.permissions.cross_chain_grants} cross-chain grant${s.permissions.cross_chain_grants > 1 ? "s" : ""}` : ""}
                                </p>
                              </div>

                              {s.revocable && (
                                <button
                                  onClick={() => onCancel(s)}
                                  disabled={busy}
                                  className="shrink-0 self-start rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                                >
                                  {busy ? "Working…" : "Cancel"}
                                </button>
                              )}
                            </div>

                            {/* Cross-chain renewal grants, one row per authorized
                                chain. A subscriber who authorized three chains
                                should be able to withdraw one without losing the
                                other two — the previous single switch was all or
                                nothing. */}
                            {TIER2_ENABLED && s.status !== "cancelled" && (
                              <div className="mt-3 border-t border-gray-100 pt-3">
                                {s.cross_chain_enabled ? (
                                  <>
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="text-xs text-gray-500">
                                        Renewals can fall back to these chains:
                                      </span>
                                      {s.grants.length > 1 && (
                                        <button
                                          onClick={() => onRevokeGrant(s)}
                                          disabled={busyId === s.id}
                                          className="shrink-0 text-[11px] font-semibold text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-50"
                                        >
                                          {busyId === s.id ? "Working…" : "Turn off all"}
                                        </button>
                                      )}
                                    </div>
                                    <ul className="mt-2 space-y-1.5">
                                      {s.grants.map((g) => {
                                        const gBusy = busyId === `${s.id}:${g.chain_id}`;
                                        return (
                                          <li
                                            key={g.chain_id}
                                            className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5"
                                          >
                                            <span className="text-xs text-gray-700">
                                              {CHAIN_NAMES[g.chain] ?? g.chain}
                                              <span className="text-gray-400">
                                                {" "}
                                                · up to {formatUnits(BigInt(g.period_amount), 6)} USDC per period
                                              </span>
                                            </span>
                                            <button
                                              onClick={() => onRevokeGrant(s, g.chain_id)}
                                              disabled={gBusy || busyId === s.id}
                                              className="shrink-0 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                                            >
                                              {gBusy ? "Working…" : "Turn off"}
                                            </button>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </>
                                ) : (
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs text-gray-500">
                                      Let renewals fall back to your USDC on Base / Arbitrum / Optimism.
                                    </span>
                                    <button
                                      onClick={() => onEnableGrant(s)}
                                      disabled={busy}
                                      className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
                                    >
                                      {busy ? "Authorizing…" : address ? "Enable" : "Connect wallet"}
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}

            <p className="mt-6 text-center text-[11px] text-gray-400">
              Cancelling and turning off cross-chain are gasless — the platform covers it. Either one stops
              us charging you; the permission you signed stays in your wallet until you remove it there.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
