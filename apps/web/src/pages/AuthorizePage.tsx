import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits } from "viem";
import { Logo } from "@/components/ui/Logo";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
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
  const msg = e instanceof Error ? e.message : String(e);
  if (/rejected|denied|cancell?ed/i.test(msg)) return "You cancelled the signature request.";
  if (/does not support|unsupported/i.test(msg)) {
    return "This wallet can't grant spending permissions. MetaMask supports them today.";
  }
  return msg || "Something went wrong. Please try again.";
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
        (done, total) => setProgress({ done, total })
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

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header className="flex items-center justify-between border-b border-gray-100 bg-white px-6 py-4">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <span className="text-lg font-bold tracking-tight text-gray-900">Sweep Console</span>
          <span className="ml-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
            Authorize
          </span>
        </Link>
      </header>
      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-12">{children}</main>
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
      <div className="mx-auto max-w-md rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-xl">
        <h1 className="text-xl font-bold text-gray-900">Nothing to authorize</h1>
        <p className="mt-2 text-sm text-gray-500">{why}</p>
        <p className="mt-4 text-sm text-gray-500">
          Ask {view?.merchant_name ?? "the business"} to send you a new link.
        </p>
      </div>
    );
  }

  const noun = INTERVAL_NOUN[view.interval] ?? view.interval;
  const chainNames = view.targets.map((t) => CHAIN_BLURB[t.chain_key] ?? t.name);
  const remaining = view.targets.filter((t) => !signedChains.includes(t.chain_id));

  if (phase === "done") {
    return shell(
      <div className="mx-auto max-w-md rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
        <h1 className="text-xl font-bold text-gray-900">You&rsquo;re set up</h1>
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
            className="mt-6 block w-full rounded-lg bg-gray-900 py-2.5 text-center font-medium text-white transition hover:bg-black"
          >
            Back to {view.merchant_name}
          </a>
        )}
      </div>
    );
  }

  return shell(
    <div className="mx-auto max-w-md rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
      <p className="text-sm text-gray-500">Recurring payment authorization</p>
      <h1 className="mt-1 text-xl font-bold text-gray-900">{view.merchant_name}</h1>

      {/* The ceiling first, in money and in words. The on-chain cap is the only
          consumer protection on this rail, so it should be the largest thing on
          the page — not a detail under a button. */}
      <div className="mt-6 rounded-xl border border-gray-100 bg-gray-50 p-5">
        <p className="text-3xl font-bold tracking-tight text-gray-900">
          {usdc(view.max_amount)}
          <span className="ml-1 text-base font-medium text-gray-500">per {noun} maximum</span>
        </p>
        <p className="mt-2 text-sm text-gray-600">
          {view.merchant_name} can charge you up to this much in total per {noun} — in one charge or several. They
          cannot take more. Each chain you authorize enforces its own share in your wallet; Sweep enforces the total
          across them.
        </p>
      </div>

      <dl className="mt-6 space-y-3 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-gray-500">Paid in</dt>
          <dd className="text-right font-medium text-gray-900">USDC from {chainNames.join(", ")}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-gray-500">Expires</dt>
          <dd className="text-right font-medium text-gray-900">
            {new Date(view.expires_at).toLocaleDateString()}
          </dd>
        </div>
        {view.email && (
          <div className="flex justify-between gap-4">
            <dt className="text-gray-500">For</dt>
            <dd className="text-right font-medium text-gray-900">{view.email}</dd>
          </div>
        )}
      </dl>

      <p className="mt-6 text-xs leading-relaxed text-gray-500">
        {view.merchant_name} decides when to charge and for how much, within the limit above. Sweep Console moves the
        money on their instruction — we don&rsquo;t set the price or the schedule. You can withdraw this permission at
        any time from your wallet, and nothing is charged today.
      </p>

      {error && <p className="mt-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

      {signedChains.length > 0 && remaining.length > 0 && (
        <p className="mt-5 rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-700">
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
            className="w-full rounded-lg bg-gray-900 py-2.5 font-medium text-white transition hover:bg-black"
          >
            Connect wallet
          </button>
        ) : (
          <>
            <button
              onClick={authorize}
              disabled={phase === "signing" || remaining.length === 0}
              className="w-full rounded-lg bg-gray-900 py-2.5 font-medium text-white transition hover:bg-black disabled:opacity-50"
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
    </div>
  );
}
