import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits } from "viem";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
import { Spinner, ActivityBar } from "@/components/ui/Spinner";
import { MetaMaskMark } from "@/components/ui/MetaMaskMark";
import { CHAIN_MARKS } from "@/components/landing/ChainMarks";
import { friendlyError } from "@/lib/errors";
import {
  getAuthorization,
  saveAuthorizationGrant,
  completeAuthorization,
  requestAuthorizationOtp,
  verifyAuthorizationOtp,
  type AuthorizationView,
} from "@/lib/gateway";

// The one screen where a subscriber sees what they are agreeing to on the
// external rail — and the only one. On hosted checkout Sweep sets the terms and
// can stand behind them; here the merchant sets them and Sweep merely executes,
// so nothing downstream re-confirms anything. That asymmetry is why this page
// leads with the merchant's name and the ceiling rather than with a button, and
// why it says plainly what the signature does and does not permit.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INTERVAL_NOUN: Record<string, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

const CHAIN_BLURB: Record<string, string> = {
  arc: "Arc",
  base: "Base",
  optimism: "Optimism",
  arbitrum: "Arbitrum",
};

function usdc(micro: number): string {
  return `$${formatUnits(BigInt(micro), 6)}`;
}

function describeError(e: unknown): string {
  return friendlyError(e, "Something went wrong. Please try again.");
}

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

type Phase = "loading" | "review" | "signing" | "done" | "gone";

export function AuthorizePage() {
  const { mandate_id: mandateId } = useParams<{ mandate_id: string }>();
  const { address } = useAccount();
  const { openConnectModal } = useConnectModal();

  const [view, setView] = useState<AuthorizationView | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [signedChains, setSignedChains] = useState<number[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);

  // Proving the payer's address, before any wallet prompt. Until this step
  // existed the rail recorded a wallet and a developer's assertion about who
  // owned it, and nothing tied the authorization to a person who had agreed.
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailToken, setEmailToken] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState("");

  const load = useCallback(async () => {
    if (!mandateId) return;
    try {
      const v = await getAuthorization(mandateId);
      setView(v);
      setSignedChains(v.granted_chain_ids);
      if (v.email) setEmail(v.email);
      // Active does not mean finished. A payer who skipped a chain can come back
      // and add it while the link lives: POST /grant accepts an active mandate,
      // and /complete explicitly handles "the subscriber adding a chain later".
      // This page was the only thing that did not — it sent every active mandate
      // straight to the success card, so the sentence that card prints, "you can
      // open this link again to add them", was not true of the page printing it.
      if (v.status === "active") {
        const left = v.targets.filter((t) => !v.granted_chain_ids.includes(t.chain_id));
        setPhase(left.length > 0 && !v.link_expired ? "review" : "done");
      }
      else if (v.status === "revoked" || v.status === "expired" || v.link_expired) setPhase("gone");
      else setPhase("review");
    } catch (e) {
      setError(describeError(e));
      setPhase("gone");
    }
  }, [mandateId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sendCode = async () => {
    if (!view || !mandateId) return;
    setOtpError("");
    setOtpBusy(true);
    try {
      await requestAuthorizationOtp(mandateId, view.session_token, email.trim());
      setOtpSent(true);
    } catch (e) {
      setOtpError(friendlyError(e, "We couldn't send your code. Try again."));
    } finally {
      setOtpBusy(false);
    }
  };

  const checkCode = async () => {
    if (!view || !mandateId) return;
    setOtpError("");
    setOtpBusy(true);
    try {
      const r = await verifyAuthorizationOtp(mandateId, view.session_token, email.trim(), code.trim());
      setEmailToken(r.email_token);
    } catch (e) {
      setOtpError(friendlyError(e, "That code didn't work. Try again."));
    } finally {
      setOtpBusy(false);
    }
  };

  const authorize = async () => {
    if (!view || !mandateId || !address) return;
    // Only sign the chains that aren't already signed — re-signing one replaces
    // its grant, which is wasted gas and a second confusing wallet prompt.
    const todo = view.targets.filter((t) => !signedChains.includes(t.chain_id));
    if (todo.length === 0) return;

    setError("");
    setSkipped([]);
    setPhase("signing");
    setProgress({ done: 0, total: todo.length });
    try {
      const failures = await grantRenewalMandates(
        address,
        todo,
        (body) =>
          saveAuthorizationGrant(mandateId, {
            ...body,
            session_token: view.session_token,
            email_token: emailToken,
          }),
        (done, total) => setProgress({ done, total }),
        view.merchant_name
      );
      // A chain that failed does not cost the subscriber the ones that worked —
      // say which were skipped rather than pretending everything succeeded.
      setSkipped(failures.map((f) => CHAIN_BLURB[f.target.chain_key] ?? f.target.name));
      await completeAuthorization(mandateId, view.session_token, address);
      await load();
      setPhase("done");
    } catch (e) {
      setError(describeError(e));
      setPhase("review");
    } finally {
      setProgress(null);
    }
  };

  /// No top nav. This page asks one question — will you let this business charge
  /// your wallet — and a header offering links elsewhere competes with it. The
  /// platform's name belongs in the footer, where it reads as provenance rather
  /// than navigation.
  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ground px-4 py-10">
      <main className="w-full max-w-md">{children}</main>
      <p className="mt-6 text-center text-[11px] uppercase tracking-[0.14em] text-gray-400">
        <Link to="/" className="hover:text-gray-600">Secured by Sweep Console</Link>
        {" · "}Non-custodial
      </p>
    </div>
  );

  if (phase === "loading") {
    return shell(<p className="text-center text-sm text-gray-500">Loading…</p>);
  }

  if (phase === "gone" || !view) {
    const why =
      error ||
      (view?.status === "revoked"
        ? "This authorization was cancelled."
        : view?.link_expired
          ? "This link has expired."
          : "This authorization is no longer available.");
    return shell(
      <div className="border border-gray-200 bg-white shadow-sm">
        <div className="h-1.5 bg-gray-300" />
        <div className="px-8 py-7 text-center">
          <h1 className="text-xl font-bold text-gray-900">Nothing to authorize</h1>
          <p className="mt-2 text-sm text-gray-500">{why}</p>
          <p className="mt-4 text-sm text-gray-500">
            Ask {view?.merchant_name ?? "the business"} to send you a new link.
          </p>
        </div>
      </div>
    );
  }

  const noun = INTERVAL_NOUN[view.interval] ?? view.interval;
  // `progress.done` counts completed signatures, so it indexes the one in flight
  // within the same `todo` list `authorize` built — the unsigned targets, in order.
  const signingChain = progress
    ? view.targets.filter((t) => !signedChains.includes(t.chain_id))[progress.done] ?? null
    : null;
  const signingTarget = signingChain ? CHAIN_BLURB[signingChain.chain_key] ?? signingChain.name : null;
  const chainNames = view.targets.map((t) => CHAIN_BLURB[t.chain_key] ?? t.name);
  // Proved in this browser, this visit. A mandate verified elsewhere still
  // shows the step: the token is what /grant checks, and we do not have it.
  const verified = !!emailToken;
  const remaining = view.targets.filter((t) => !signedChains.includes(t.chain_id));

  if (phase === "done") {
    return shell(
      <div className="border border-gray-200 bg-white shadow-sm">
        <div className="h-1.5 bg-brand-600" />
        <div className="px-8 py-7">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-700">Authorized</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">You&rsquo;re set up</h1>
        <p className="mt-2 text-sm text-gray-600">
          {view.merchant_name} can now charge up to <strong>{usdc(view.max_amount)}</strong> per {noun} from your
          wallet, until {new Date(view.expires_at).toLocaleDateString()}.
        </p>
        {signedChains.length > 0 && (
          <p className="mt-3 text-sm text-gray-500">
            Authorized on{" "}
            {view.targets
              .filter((t) => signedChains.includes(t.chain_id))
              .map((t) => CHAIN_BLURB[t.chain_key] ?? t.name)
              .join(", ")}
            .
          </p>
        )}
        {skipped.length > 0 && (
          <div className="mt-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="m-0">
              {skipped.join(" and ")} {skipped.length === 1 ? "was" : "were"} skipped.
            </p>
            {remaining.length > 0 && !view.link_expired && (
              <button
                onClick={() => { setSkipped([]); setError(""); setPhase("review"); }}
                className="mt-2 font-semibold underline underline-offset-2 hover:no-underline"
              >
                Add {skipped.length === 1 ? "it" : "them"} now
              </button>
            )}
          </div>
        )}
        <p className="mt-4 text-sm text-gray-500">
          To stop it, remove the permission in your wallet, or ask {view.merchant_name} to cancel.
        </p>
        {view.return_url && (
          <a
            href={view.return_url}
            className="mt-6 block w-full bg-brand-600 py-3 text-center font-semibold text-white transition hover:bg-brand-700"
          >
            Back to {view.merchant_name}
          </a>
        )}
        </div>
      </div>
    );
  }

  // The hero drops a trailing ".00" — "5 USDC" is the number a person repeats
  // back to themselves; "5.00 USDC" is a receipt. Cents survive when they exist.
  const heroAmount = usdc(view.max_amount).replace(/\.00$/, "");

  return shell(
    <div className="border border-gray-200 bg-white shadow-sm">
      {/* The accent rule is the only ornament: it marks this as a payment
          surface without a logo competing with the merchant's name. */}
      <div className="h-1.5 bg-brand-600" />

      <div className="px-8 py-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-700">
          Recurring payment authorization
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900">{view.merchant_name}</h1>

        <div className="mt-5 border-t border-gray-900" />

        {/* The ceiling, as the largest thing on the page. It is the only
            consumer protection on this rail, so it outranks the button. */}
        <div className="mt-6 flex items-baseline gap-2">
          <span className="text-5xl font-bold leading-none tracking-tight text-gray-900">{heroAmount}</span>
          <span className="text-lg font-bold text-gray-900">USDC</span>
          <span className="text-sm text-gray-500">per {noun}, maximum</span>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-gray-600">
          Pay up to this charge a {noun} from any of the chains below.
        </p>

        <dl className="mt-6 text-sm">
          <div className="flex justify-between gap-4 border-t border-gray-100 py-3">
            <dt className="text-gray-500">Paid in</dt>
            <dd className="text-right font-medium text-gray-900">USDC from {chainNames.join(", ")}</dd>
          </div>
          <div className="border-t border-gray-100" />
        </dl>

        {error && (
          <p className="mt-5 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        )}

        {signedChains.length > 0 && remaining.length > 0 && (
          <p className="mt-5 border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            Already authorized on{" "}
            {view.targets
              .filter((t) => signedChains.includes(t.chain_id))
              .map((t) => CHAIN_BLURB[t.chain_key] ?? t.name)
              .join(", ")}
            . {remaining.length} more to go.
          </p>
        )}

        {/* Step one, and it has to be first: a signature proves a wallet, not a
            person. The merchant is told who authorized this, receipts go to
            this address, and the payer becomes the same Customer they are for
            anything else they have bought here — none of which a wallet
            connection can establish.

            Prefilled when the developer named an address, never locked to it.
            An address a merchant holds is eventually a stale address, and
            pinning it here turns a typo in their CRM into a payer who cannot
            authorize at all. What they proved is reported back beside what was
            asked for, so a mismatch is the merchant's to reconcile. */}
        {!verified && (
          <div className="mt-6">
            <p className="mb-2 text-[10px] uppercase tracking-[0.14em] text-gray-500">Your email</p>
            <div className="border-t border-gray-100 pt-3">
              <div className="flex flex-wrap gap-2">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    // Changing the address retires the code sent to the old
                    // one. Leaving the code box up would invite typing a code
                    // that can only ever fail.
                    if (otpSent) {
                      setOtpSent(false);
                      setCode("");
                      setOtpError("");
                    }
                  }}
                  placeholder="you@example.com"
                  className="min-w-0 flex-1 border border-gray-300 px-3 py-2 text-sm"
                />
                {!otpSent ? (
                  <button
                    onClick={() => void sendCode()}
                    disabled={otpBusy || !EMAIL_RE.test(email.trim())}
                    className="inline-flex items-center gap-2 bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    {otpBusy && <Spinner size={14} tone="onAccent" />}
                    Send code
                  </button>
                ) : (
                  <button
                    onClick={() => void sendCode()}
                    disabled={otpBusy}
                    className="px-3 py-2 text-sm font-medium text-gray-500 underline disabled:opacity-40"
                  >
                    Resend
                  </button>
                )}
              </div>

              {otpSent && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    inputMode="numeric"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="6-digit code"
                    className="min-w-0 flex-1 border border-gray-300 px-3 py-2 text-sm tracking-[0.3em]"
                  />
                  <button
                    onClick={() => void checkCode()}
                    disabled={otpBusy || code.trim().length < 4}
                    className="inline-flex items-center gap-2 bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    {otpBusy && <Spinner size={14} tone="onAccent" />}
                    Verify
                  </button>
                </div>
              )}

              {otpError && <p className="mt-2 text-sm text-red-700">{otpError}</p>}
              {otpSent && !otpError && (
                <p className="mt-2 text-xs text-gray-500">We sent a code to {email.trim()}.</p>
              )}
            </div>
          </div>
        )}

        {verified && (
          <div className="mt-6 flex items-center gap-2 border-t border-gray-100 pt-3">
            <span className="block h-2 w-2 bg-brand-600" />
            <span className="text-sm text-gray-900">{email.trim()}</span>
            <span className="ml-auto text-xs font-semibold uppercase tracking-wider text-brand-700">
              Verified
            </span>
          </div>
        )}

        {/* Which chains are authorized, and which are still waiting.
            Faint until signed, full once the grant lands — the payer signs one
            chain at a time and this is the only thing on the page that says how
            far through they are. Rendered from `targets` rather than a fixed
            three, so a mandate offered on fewer chains shows fewer. */}
        <div className="mt-6">
          <p className="mb-2 text-[10px] uppercase tracking-[0.14em] text-gray-500">Approve chains</p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-gray-100 pt-3">
            {view.targets.map((t) => {
              const Mark = CHAIN_MARKS[t.chain_key];
              const on = signedChains.includes(t.chain_id);
              // The one whose wallet prompt is open right now. Without this a
              // chain being signed looks exactly like one not started, which is
              // the moment the payer most needs the page to point somewhere:
              // MetaMask opens one prompt per chain, and between dismissing one
              // and the next appearing there is nothing on screen to say which.
              const busy = !on && signingChain?.chain_id === t.chain_id;
              const name = CHAIN_BLURB[t.chain_key] ?? t.name;
              return (
                <span key={t.chain_id} className="flex items-center gap-2">
                  {Mark && (
                    <span className={busy ? "animate-pulse" : undefined}>
                      <Mark height={20} opacity={on ? 1 : busy ? 0.75 : 0.3} />
                    </span>
                  )}
                  <span
                    className={
                      on || busy ? "text-sm font-medium text-gray-900" : "text-sm text-gray-400"
                    }
                  >
                    {name}
                  </span>
                  {/* Opacity and a pulse are not state a screen reader can read,
                      and colour alone is not either. Say it. */}
                  <span className="sr-only">
                    {on ? "authorized" : busy ? "waiting for your wallet" : "not yet authorized"}
                  </span>
                </span>
              );
            })}
          </div>
        </div>

        <div className="mt-6">
          {!verified ? (
            <p className="border border-gray-200 bg-gray-50 px-4 py-3 text-center text-sm text-gray-500">
              Verify your email to continue.
            </p>
          ) : !address ? (
            <button
              onClick={openConnectModal}
              className="flex w-full items-center justify-center gap-2.5 bg-brand-600 py-3 font-semibold text-white transition hover:bg-brand-700"
            >
              Connect wallet
              <MetaMaskMark height={20} />
            </button>
          ) : (
            <>
              <button
                onClick={authorize}
                disabled={phase === "signing" || remaining.length === 0}
                className="flex w-full items-center justify-center gap-2.5 bg-brand-600 py-3 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
              >
                {phase === "signing" && <Spinner size={16} tone="onAccent" />}
                {phase === "signing"
                  ? progress
                    ? `Authorizing ${progress.done + 1} of ${progress.total}…`
                    : "Authorizing…"
                  : `Authorize ${usdc(view.max_amount)} per ${noun}`}
              </button>

              {/* The longest wait on this rail, and the one most likely to be
                  read as "nothing happened": each chain needs its own wallet
                  prompt, and between dismissing one and the next appearing there
                  is a gap with no browser chrome to explain it. So the page says
                  which network it is asking about, and keeps moving while it
                  waits. */}
              {phase === "signing" ? (
                <div className="mt-3">
                  <ActivityBar />
                  <p className="mt-2 text-center text-xs text-gray-500">
                    {signingTarget
                      ? <>Confirm in your wallet to authorize on <strong>{signingTarget}</strong>.</>
                      : "Confirm in your wallet."}
                    {progress && progress.total > 1 && (
                      <> {progress.total - progress.done - 1 > 0
                        ? `${progress.total - progress.done - 1} more after this one.`
                        : "This is the last one."}</>
                    )}
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-center text-xs text-gray-400">
                  Signing as {shortAddress(address)}
                  {view.targets.length > 1 && ` · ${view.targets.length} signatures, one per network`}
                </p>
              )}
            </>
          )}
        </div>

        {/* Who decides what, in the subscriber's own terms. The distinction
            matters on this rail: the merchant sets the amount and the timing,
            and the platform they are trusting with a standing permission is not
            the one deciding how much to take. */}
        <p className="mt-5 text-xs leading-relaxed text-gray-500">
          {view.merchant_name} decides when to charge, within the limit above. Sweep Console moves the money on their
          instruction and never holds it. Withdraw this permission anytime from your wallet.
        </p>
      </div>
    </div>
  );
}
