import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits } from "viem";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
import { friendlyError } from "@/lib/errors";
import {
  getAuthorization,
  saveAuthorizationGrant,
  completeAuthorization,
  type AuthorizationView,
} from "@/lib/gateway";

// The one screen where a subscriber sees what they are agreeing to on the
// external rail — and the only one. On hosted checkout Sweep sets the terms and
// can stand behind them; here the merchant sets them and Sweep merely executes,
// so nothing downstream re-confirms anything. That asymmetry is why this page
// leads with the merchant's name and the ceiling rather than with a button, and
// why it says plainly what the signature does and does not permit.

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

  const load = useCallback(async () => {
    if (!mandateId) return;
    try {
      const v = await getAuthorization(mandateId);
      setView(v);
      setSignedChains(v.granted_chain_ids);
      if (v.status === "active") setPhase("done");
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
        (body) => saveAuthorizationGrant(mandateId, { ...body, session_token: view.session_token }),
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
  const chainNames = view.targets.map((t) => CHAIN_BLURB[t.chain_key] ?? t.name);
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
          <p className="mt-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {skipped.join(" and ")} {skipped.length === 1 ? "was" : "were"} skipped — you can open this link again to
            add {skipped.length === 1 ? "it" : "them"}.
          </p>
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
          They can charge up to this much a {noun} — in one charge or several — and never more, across every chain
          you approve.
        </p>

        <dl className="mt-6 text-sm">
          <div className="flex justify-between gap-4 border-t border-gray-100 py-3">
            <dt className="text-gray-500">Paid in</dt>
            <dd className="text-right font-medium text-gray-900">USDC from {chainNames.join(", ")}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-gray-100 py-3">
            <dt className="text-gray-500">Expires</dt>
            <dd className="text-right font-medium text-gray-900">
              {new Date(view.expires_at).toLocaleDateString(undefined, {
                year: "numeric", month: "short", day: "numeric",
              })}
            </dd>
          </div>
          {view.email && (
            <div className="flex justify-between gap-4 border-t border-gray-100 py-3">
              <dt className="text-gray-500">For</dt>
              <dd className="break-all text-right font-medium text-gray-900">{view.email}</dd>
            </div>
          )}
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

        <div className="mt-6">
          {!address ? (
            <button
              onClick={openConnectModal}
              className="w-full bg-brand-600 py-3 font-semibold text-white transition hover:bg-brand-700"
            >
              Connect wallet
            </button>
          ) : (
            <>
              <button
                onClick={authorize}
                disabled={phase === "signing" || remaining.length === 0}
                className="w-full bg-brand-600 py-3 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
              >
                {phase === "signing"
                  ? progress
                    ? `Authorizing ${progress.done + 1} of ${progress.total}…`
                    : "Authorizing…"
                  : `Authorize ${usdc(view.max_amount)} per ${noun}`}
              </button>
              <p className="mt-3 text-center text-xs text-gray-400">
                Signing as {shortAddress(address)}
                {view.targets.length > 1 && ` · ${view.targets.length} signatures, one per network`}
              </p>
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
