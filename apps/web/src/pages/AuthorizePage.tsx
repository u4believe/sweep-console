import { TestModeBanner } from "@/components/checkout/TestModeBanner";
import { fetchConfig } from "@/lib/gateway";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount, useDisconnect } from "wagmi";
import {
  beginEmbedHandshake,
  injectedProviderReachable,
  isEmbedded,
  openAuthorizePopup,
  relayPopupResult,
  reportAuthorized,
  reportCancelled,
} from "../lib/embed";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits } from "viem";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
import { Spinner, ActivityBar } from "@/components/ui/Spinner";
import { MetaMaskMark } from "@/components/ui/MetaMaskMark";
import { ChainMark } from "@/components/ui/marks";
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

/**
 * Shorter names for the chains, where shortening loses nothing.
 *
 * It used to map base -> "Base" unconditionally, which ALSO erased the one
 * signal a payer had about which network they were on: the API sends "Base
 * Sepolia" on testnet, and this turned it into "Base". A sandbox grant then
 * looked identical to a real one.
 *
 * So the blurb only applies on mainnet. Testnet keeps the API's name, where
 * the word Sepolia is the point.
 */
const CHAIN_BLURB: Record<string, string> = {
  arc: "Arc",
  base: "Base",
  optimism: "Optimism",
  arbitrum: "Arbitrum",
};

/** The blurb when it is safe to shorten, the API's own name when it is not. */
function chainLabel(key: string, name: string, isTest: boolean): string {
  return isTest ? name : CHAIN_BLURB[key] ?? name;
}

function usdc(micro: number): string {
  return `$${formatUnits(BigInt(micro), 6)}`;
}

function describeError(e: unknown): string {
  return friendlyError(e, "Something went wrong. Please try again.");
}

/**
 * The card, matched to the hosted checkout's payment card.
 *
 * Those two surfaces were square with a drop shadow here and rounded with no
 * shadow there, which is what reads as "slightly different" even though the
 * palette is identical — tailwind.config maps gray-* onto the same neutral
 * ramp the tokens use, so only the SHAPE ever diverged.
 *
 * rounded-xl is 12px against the hosted card's --radius-lg of 14; close
 * enough that no payer sees a difference and it stays a Tailwind utility
 * rather than an inline style in a file that has none.
 *
 * The shadow is dropped inside the panel: the modal already casts one, and
 * two stacked shadows on the same rectangle is how a card starts looking
 * like it is floating off the page.
 */
const CARD_BASE = "overflow-hidden rounded-[14px] border border-gray-200 bg-white shadow-sm";

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

type Phase = "loading" | "review" | "signing" | "done" | "gone";

export function AuthorizePage() {
  const { mandate_id: mandateId } = useParams<{ mandate_id: string }>();
  const { address, status: walletStatus } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();

  const [view, setView] = useState<AuthorizationView | null>(null);
  // Only to decide whether a chain name may be shortened; the banner reads
  // the same value for itself.
  const [isTestMode, setIsTestMode] = useState(false);
  useEffect(() => {
    let alive = true;
    void fetchConfig()
      .then((c) => { if (alive) setIsTestMode(c.mode === "test"); })
      .catch(() => { /* shortening stays on, which is the mainnet behaviour */ });
    return () => { alive = false; };
  }, []);
  /**
   * Framed by @sweepconsole/js, as opposed to opened directly.
   *
   * Read once rather than per render: it cannot change for the life of the
   * page, and a value that flickers would move the layout under the payer.
   */
  const [embedded] = useState(isEmbedded);
  /**
   * One card, shadowed either way.
   *
   * The shadow was dropped when embedded because the panel cast its own and
   * two on one rectangle looked wrong. That reasoning died with the white
   * panel: the card now sits on the #F4F4FB tint exactly as the hosted
   * checkout's does, and without a shadow a white card on a tint is a flat
   * patch rather than a card.
   */
  const CARD = CARD_BASE;

  // Knock on the host's door as soon as this mounts. Before the view loads —
  // otherwise the merchant watches an empty panel while we fetch.
  useEffect(() => { beginEmbedHandshake(); }, []);

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [signedChains, setSignedChains] = useState<number[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  // The chains this run is working through, in order. Held separately because
  // signedChains now grows DURING the run, so deriving the in-flight one by
  // filtering it would walk off the list as it shrinks.
  const [todoIds, setTodoIds] = useState<number[]>([]);
  /**
   * Which chains the payer wants to authorize.
   *
   * Every ungranted chain starts selected, so a payer who does not care gets
   * what this page did before: all of them, one run, no decision. Deselecting
   * is the new part — authorizing on three chains was previously the only
   * option, and a payer who only ever funds one was signing two prompts for
   * permissions they did not want to give.
   *
   * null until the view loads, so "nothing selected yet" and "deliberately
   * none" are not the same state.
   */
  const [picked, setPicked] = useState<number[] | null>(null);

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
      setPicked((cur) =>
        cur ?? v.targets.filter((t) => !v.granted_chain_ids.includes(t.chain_id)).map((t) => t.chain_id)
      );
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
    // Only the chains the payer picked, and only those not already signed —
    // re-signing one replaces its grant, which is wasted gas and a second
    // confusing wallet prompt.
    const todo = view.targets.filter(
      (t) => !signedChains.includes(t.chain_id) && (picked ?? []).includes(t.chain_id)
    );
    if (todo.length === 0) return;

    setError("");
    setSkipped([]);
    setPhase("signing");
    setTodoIds(todo.map((t) => t.chain_id));
    setProgress({ done: 0, total: todo.length });
    try {
      const failures = await grantRenewalMandates(
        address,
        todo,
        async (body) => {
          const saved = await saveAuthorizationGrant(mandateId, {
            ...body,
            session_token: view.session_token,
            email_token: emailToken,
          });
          // Mark it the moment it lands, not when the whole run finishes. The
          // strip read from a list that only refreshed at the end, so a chain
          // the payer had just signed sat faint while the next one pulsed —
          // the two states that matter looked identical.
          const id = Number((body as { chain_id?: unknown }).chain_id);
          if (Number.isFinite(id)) {
            setSignedChains((cur) => (cur.includes(id) ? cur : [...cur, id]));
          }
          return saved;
        },
        (done, total) => setProgress({ done, total }),
        view.merchant_name
      );
      // A chain that failed does not cost the subscriber the ones that worked —
      // say which were skipped rather than pretending everything succeeded.
      setSkipped(failures.map((f) => chainLabel(f.target.chain_key, f.target.name, isTestMode)));
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
  // Inside the shell, so every phase of the flow carries it — loading,
  // connect, sign and done alike.
  const shell = (children: React.ReactNode) => (
    /**
     * Framed, this fills the panel the host already sized and centred, so
     * centring again inside it would leave the content floating in a box
     * within a box. Unframed it is the page, unchanged.
     */
    <div
      className={
        embedded
          ? "flex min-h-full flex-col bg-[#F4F4FB] px-7 py-7"
          : "flex min-h-screen flex-col items-center justify-center bg-ground px-4 py-10"
      }
    >
      <div className={embedded ? "" : "fixed inset-x-0 top-0 z-50"}><TestModeBanner /></div>
      {/*
        540px, which is the hosted checkout's card width, so the two read as
        one product. Embedded it was w-full and therefore as wide as whatever
        panel it landed in — at a 600px panel that is a 600px column of text,
        which is wider than anything else this product shows a payer.
      */}
      <main className={embedded ? "mx-auto w-full max-w-[460px]" : "w-full max-w-md"}>{children}</main>
      {/*
        The provenance line, and in a frame it is also the only thing telling
        the payer whose checkout this is. The link is dropped there: it would
        navigate the panel to the marketing site with no way back, stranding
        them inside a box on someone else's page.
      */}
      <p className="mt-3 text-center text-[11px] uppercase tracking-[0.14em] text-gray-600">
        {embedded ? (
          <span>Secured by Sweep Console</span>
        ) : (
          <Link to="/" className="hover:text-gray-600">Secured by Sweep Console</Link>
        )}
        {" · "}Non-custodial
      </p>
    </div>
  );

  /**
   * Tell whoever opened us, once.
   *
   * In an effect rather than at the moment of signing, because this must also
   * fire for a payer who arrives already authorized — the load path jumps
   * straight to "done" and never passes through the signing code.
   *
   * reportAuthorized decides where it goes: to the host when framed, to the
   * opening iframe when we are the popup it spawned, and nowhere at all when
   * the page was opened directly, which is the ordinary case.
   */
  useEffect(() => {
    if (phase === "done") reportAuthorized(mandateId);
  }, [phase, mandateId]);

  /**
   * Framed, with no injected wallet to talk to.
   *
   * A browser extension is not obliged to inject itself into a cross-origin
   * iframe. Where it has not, every connector that needs an injected provider
   * is a dead end that looks like a broken button: the payer clicks Connect
   * and nothing happens, with no error to act on.
   *
   * So the button changes what it does instead of what it says afterwards.
   * WalletConnect would still work in the frame, so this is not "no wallet
   * possible" — it is "the one most payers use is missing", which is enough
   * to be worth the window. A payer who does have MetaMask never sees this.
   */
  const needsPopup = embedded && !injectedProviderReachable();

  /**
   * Hand the signing over to another wallet.
   *
   * The payer could see no address and had no way to change it: connect the
   * wrong account and the only exit was disconnecting in the extension and
   * reloading. On a page that is about to take a standing claim on a wallet,
   * not naming which wallet is the wrong thing to be silent about.
   *
   * Disconnect first, THEN open the picker. RainbowKit will not offer a
   * different account while one is connected — it shows the account sheet
   * instead — so without the disconnect the button appears to do nothing.
   */
  const switchWallet = () => {
    disconnect();
    // After wagmi has settled, or the modal opens against the old account.
    setTimeout(() => openConnectModal?.(), 0);
  };

  const connectWallet = () => {
    if (!needsPopup) {
      openConnectModal?.();
      return;
    }
    // Inside the click, or the popup is blocked — and blocked silently.
    const win = openAuthorizePopup();
    if (!win) {
      setError(
        "Your browser blocked the wallet window. Allow pop-ups for this site, " +
          "or open the link this checkout came from directly."
      );
    }
  };

  /**
   * The popup is this same page in another window; when it finishes it
   * reports to us, and we are the one holding the handshake with the host.
   */
  useEffect(() => {
    if (!embedded) return;
    return relayPopupResult((id) => {
      setPhase("done");
      reportAuthorized(id ?? mandateId);
    });
  }, [embedded, mandateId]);

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
      <div className={CARD}>
        <div className="h-1 bg-gray-300" />
        <div className="px-6 py-4 text-center">
          <h1 className="text-xl font-bold text-gray-900">Nothing to authorize</h1>
          <p className="mt-2 text-sm text-gray-500">{why}</p>
          <p className="mt-2 text-sm text-gray-500">
            Ask {view?.merchant_name ?? "the business"} to send you a new link.
          </p>
          {/*
            A way out, which a framed dead end otherwise does not have.
            Unframed the payer closes the tab or uses the back button; inside
            a panel neither applies, and the host's own X is a 30px target in
            a corner they have no reason to look at. Telling the host also
            lets the merchant's page react — onCancelled fires, so it can
            offer the payer something else.
          */}
          {embedded && (
            <button
              onClick={reportCancelled}
              className="mt-3 w-full border border-gray-300 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              Close
            </button>
          )}
        </div>
      </div>
    );
  }

  const noun = INTERVAL_NOUN[view.interval] ?? view.interval;
  // `progress.done` counts completed signatures, so it indexes the one in flight
  // within the same `todo` list `authorize` built — the unsigned targets, in order.
  const signingChain = progress
    ? view.targets.find((t) => t.chain_id === todoIds[progress.done]) ?? null
    : null;
  const signingTarget = signingChain ? chainLabel(signingChain.chain_key, signingChain.name, isTestMode) : null;
  const chainNames = view.targets.map((t) => chainLabel(t.chain_key, t.name, isTestMode));
  // Proved in this browser, this visit. A mandate verified elsewhere still
  // shows the step: the token is what /grant checks, and we do not have it.
  const verified = !!emailToken;
  const remaining = view.targets.filter((t) => !signedChains.includes(t.chain_id));
  /**
   * Picking is only on offer once the payer can actually act on it: verified,
   * connected, not mid-run, and with something still ungranted. Showing
   * toggles before the wallet is connected would invite a choice that cannot
   * be carried out yet.
   */
  const canPick =
    verified && !!address && walletStatus === "connected" && phase !== "signing" && remaining.length > 0;
  const chosenRemaining = remaining.filter((t) => (picked ?? []).includes(t.chain_id));

  if (phase === "done") {
    return shell(
      <div className={CARD}>
        <div className="h-1 bg-brand-600" />
        <div className="px-6 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-700">Authorized</p>
          <h1 className="mt-2 text-xl font-bold tracking-tight text-gray-900">You&rsquo;re set up</h1>
        <p className="mt-2 text-sm text-gray-600">
          {view.merchant_name} can now charge up to <strong>{usdc(view.max_amount)}</strong> per {noun}.
        </p>
        {signedChains.length > 0 && (
          <p className="mt-2 text-sm text-gray-500">
            Authorized on{" "}
            {view.targets
              .filter((t) => signedChains.includes(t.chain_id))
              .map((t) => chainLabel(t.chain_key, t.name, isTestMode))
              .join(", ")}
            .
          </p>
        )}
        {skipped.length > 0 && (
          <div className="mt-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
        <p className="mt-2 text-sm text-gray-500">
          To stop it, remove the permission in your wallet, or visit the page below to cancel.
        </p>
        {/* The page the sentence above points at. Primary, because ending this
            is the one thing the payer may still need and the only place on the
            platform they can do it. */}
        <a
          href="/manage"
          className="mt-3 block w-full bg-brand-600 py-2.5 text-center font-semibold text-white transition hover:bg-brand-700"
        >
          Manage subscription
        </a>
        {view.return_url && (
          <a
            href={view.return_url}
            className="mt-2 block w-full py-2 text-center text-sm font-medium text-gray-500 underline underline-offset-2 hover:no-underline"
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
    <div className={CARD}>
      {/* The accent rule is the only ornament: it marks this as a payment
          surface without a logo competing with the merchant's name. */}
      <div className="h-1 bg-brand-600" />

      <div className="px-6 py-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-700">
          Recurring payment authorization
        </p>
        <h1 className="mt-2 text-xl font-bold tracking-tight text-gray-900">{view.merchant_name}</h1>

        <div className="mt-3 border-t border-gray-900" />

        {/* The ceiling, as the largest thing on the page. It is the only
            consumer protection on this rail, so it outranks the button. */}
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-3xl font-bold leading-none tracking-tight text-gray-900">{heroAmount}</span>
          <span className="text-base font-bold text-gray-900">USDC</span>
          <span className="text-sm text-gray-500">per {noun}, maximum</span>
        </div>

        <p className="mt-3 text-sm leading-snug text-gray-600">
          Pay up to this charge a {noun} from any of the chains below.
        </p>

        <dl className="mt-3 text-sm">
          <div className="flex justify-between gap-4 border-t border-gray-100 py-2">
            <dt className="text-gray-500">Paid in</dt>
            <dd className="text-right font-medium text-gray-900">USDC from {chainNames.join(", ")}</dd>
          </div>
          {/*
            True on this rail, and worth saying because a payer who has used
            a wallet before expects to pay gas on every one of these chains
            and may stop here rather than find out. They do not: the delegate
            pays to redeem, and settlement's gas comes out of the platform's
            own fee — never the amount shown above.
          */}
          <div className="flex justify-between gap-4 border-t border-gray-100 py-2">
            <dt className="text-gray-500">Network fee</dt>
            <dd className="text-right font-medium text-gray-900">Covered by Sweep Console</dd>
          </div>
          {/*
            The authorization's own expiry, not the link's. The link dying is
            this page's problem and is handled by the "gone" state; this is
            the date the standing permission stops, which is the one the payer
            is agreeing to.
          */}
          <div className="flex justify-between gap-4 border-t border-gray-100 py-2">
            <dt className="text-gray-500">Expires</dt>
            <dd className="text-right font-medium text-gray-900">
              {new Date(view.expires_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </dd>
          </div>
          <div className="border-t border-gray-100" />
        </dl>

        {error && (
          <p className="mt-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
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
          <div className="mt-3">
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

        {/*
          The settled step, as one line: number, the address it captured, and
          a green pill. The same shape the hosted checkout uses, and the
          design's — a square accent dot and an uppercase accent word was the
          Modernist idiom, which this page no longer speaks.
        */}
        {verified && (
          <div
            className="mt-3 flex items-center"
            style={{ gap: 10, padding: "12px 0", borderTop: "1px solid var(--color-divider)", fontSize: 13.5 }}
          >
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-accent)", width: 22, flex: "none" }}>
              01
            </span>
            <span>{email.trim()}</span>
            <span
              className="ml-auto"
              style={{
                fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
                color: "var(--color-ok-text)", background: "var(--color-ok-bg)",
                padding: "3px 8px", borderRadius: 5,
              }}
            >
              Verified
            </span>
          </div>
        )}

        {/* Which chains are authorized, and which are still waiting.
            Faint until signed, full once the grant lands — the payer signs one
            chain at a time and this is the only thing on the page that says how
            far through they are. Rendered from `targets` rather than a fixed
            three, so a mandate offered on fewer chains shows fewer. */}
        <div className="mt-3">
          <p className="mb-2 text-[10px] uppercase tracking-[0.14em] text-gray-500">
            {canPick ? "Choose chains" : "Approve chains"}
          </p>
          {canPick && (
            <p className="mb-2 text-xs text-gray-500">
              Pick where {view.merchant_name} may charge you. Each one is a separate signature, and
              you can add the others later from this link.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-gray-100 pt-3">
            {view.targets.map((t) => {
                            const on = signedChains.includes(t.chain_id);
              const chosen = (picked ?? []).includes(t.chain_id);
              // The one whose wallet prompt is open right now. Without this a
              // chain being signed looks exactly like one not started, which is
              // the moment the payer most needs the page to point somewhere:
              // MetaMask opens one prompt per chain, and between dismissing one
              // and the next appearing there is nothing on screen to say which.
              const busy = !on && signingChain?.chain_id === t.chain_id;
              const name = chainLabel(t.chain_key, t.name, isTestMode);
              /**
               * A signed chain is not a choice any more — re-signing it would
               * replace a grant the payer already gave, for nothing. So only
               * the ungranted ones are buttons, and only before a run starts.
               */
              const selectable = canPick && !on;
              const body = (
                <>
                  {/* No `Mark &&` guard: ChainMark renders nothing for a
                      chain it does not know, so the check moved into it. */}
                  {(
                    <span className={busy ? "animate-pulse" : undefined}>
                      <ChainMark chain={t.chain_key} size={20} opacity={on || chosen ? 1 : busy ? 0.75 : 0.3} />
                    </span>
                  )}
                  <span
                    className={
                      on || busy || chosen
                        ? "text-sm font-medium text-gray-900"
                        : "text-sm text-gray-600"
                    }
                  >
                    {name}
                  </span>
                  {/* Opacity and a pulse are not state a screen reader can read,
                      and colour alone is not either. Say it. */}
                  <span className="sr-only">
                    {on
                      ? "authorized"
                      : busy
                        ? "waiting for your wallet"
                        : selectable
                          ? chosen
                            ? "selected"
                            : "not selected"
                          : "not yet authorized"}
                  </span>
                </>
              );

              if (!selectable) {
                return (
                  <span key={t.chain_id} className="flex items-center gap-2">
                    {body}
                  </span>
                );
              }
              return (
                <button
                  key={t.chain_id}
                  type="button"
                  role="checkbox"
                  aria-checked={chosen}
                  onClick={() =>
                    setPicked((cur) => {
                      const list = cur ?? [];
                      return list.includes(t.chain_id)
                        ? list.filter((c) => c !== t.chain_id)
                        : [...list, t.chain_id];
                    })
                  }
                  className={`flex items-center gap-2 border px-2.5 py-1.5 transition ${
                    chosen
                      ? "border-brand-600 bg-brand-50"
                      : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                >
                  {body}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3">
          {!verified ? (
            <p className="border border-gray-200 bg-gray-50 px-4 py-3 text-center text-sm text-gray-500">
              Verify your email to continue.
            </p>
          ) : !address || walletStatus !== "connected" ? (
            <button
              onClick={connectWallet}
              className="flex w-full items-center justify-center gap-2.5 bg-brand-600 py-3 font-semibold text-white transition hover:bg-brand-700"
            >
              {needsPopup ? "Continue in a new window" : "Connect wallet"}
              <MetaMaskMark height={20} />
            </button>
          ) : (
            <>
              {/*
                WHICH wallet is about to sign, and a way to change it. Shown
                above the button, because it is a fact about what the button
                will do.

                Hidden while signing: a wallet prompt is open, and swapping the
                account underneath it is how a mandate ends up half-signed.
              */}
              {phase !== "signing" && (
                <div className="mb-2 flex items-center justify-between gap-3 border border-gray-200 bg-gray-50 px-3 py-2">
                  <span className="min-w-0 truncate text-xs text-gray-600">
                    Signing with <span className="font-medium text-gray-900">{shortAddress(address)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={switchWallet}
                    className="shrink-0 text-xs font-medium text-brand-700 underline underline-offset-2"
                  >
                    Connect a different wallet
                  </button>
                </div>
              )}
              {/*
                Said only once something is signed, because only then does it
                cost anything. Each chain's grant records its OWN delegator —
                RenewalDelegation.walletAddress is per row — so authorizing the
                rest from another account leaves one mandate drawing from two
                wallets, and a charge pulls from whichever signed that chain.
                Permitted, and almost certainly not what the payer pictured.
              */}
              {phase !== "signing" && signedChains.length > 0 && (
                <p className="mb-2 text-xs leading-snug text-gray-500">
                  You have already authorized {signedChains.length} chain{signedChains.length === 1 ? "" : "s"} from
                  this wallet. Switching now would authorize the rest from a different one, and each
                  chain is charged from the wallet that signed it.
                </p>
              )}
              <button
                onClick={authorize}
                disabled={phase === "signing" || chosenRemaining.length === 0}
                className="flex w-full items-center justify-center gap-2.5 bg-brand-600 py-3 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
              >
                {phase === "signing" && <Spinner size={16} tone="onAccent" />}
                {phase === "signing"
                  ? "Authorizing…"
                  : chosenRemaining.length === 0
                    ? "Choose at least one chain"
                    : `Subscribe — ${usdc(view.max_amount)} per ${noun}`}
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
              ) : walletStatus !== "connected" ? null : (
                <p className="mt-2 text-center text-xs text-gray-600">
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
        <p className="mt-3 text-xs leading-snug text-gray-500">
          {view.merchant_name} decides when to charge, within the limit above. Sweep Console moves the money on their
          instruction and never holds it. Withdraw this permission anytime from your wallet.
        </p>
      </div>
    </div>
  );
}
