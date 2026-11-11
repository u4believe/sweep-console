// "Automatic renewal" — the control that decides how many chains a renewal can
// be collected from.
//
// ONE switch, and it means "all chains".
//
// This is not a convenience. Step 03 ("Pay from") authorizes exactly the chain
// being paid from, deliberately — someone comparing Base should not be asked to
// authorize everything. But that leaves a subscription renewable on one chain
// only, and the renewal engine can collect from a granted chain only if it holds
// a full period. A wallet with 2 USDC on Base and 40 on Optimism fails its
// renewal if Base is all it granted, with the money sitting right there.
//
// So this switch is the difference between one chain and a fallback set. On, it
// authorizes every supported chain in one run: a 7702 smart-account upgrade plus
// an ERC-7715 delegation on each of Base/Arbitrum/Optimism. It is the only
// control here that opens the wallet. Off, renewals depend on a single chain
// staying funded.
//
// Chain selection stays in step 03; this component has no chain rows of its own.
// Two lists of the same chains, each with its own notion of what was chosen, is
// how a subscriber ends up unsure what they authorized.
//
// Turning it back off revokes every grant. Revocation is a server call against
// the stored delegation, so it needs no signature — and it cannot remove the
// permission from the wallet, which only the subscriber can do.
//
// Self-gating: the wallet must advertise ERC-7715 support. There is no feature
// flag any more — see TIER2_ENABLED below.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useConnectorClient } from "wagmi";
import { getSupportedDelegationChainIds } from "@/lib/delegation/capabilities";
import { ChainMark } from "@/components/ui/marks";
import { describeGrantFailure, grantDebugEnabled, reportGrantFailure } from "@/lib/delegation/diagnostics";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
import { Spinner, ActivityBar } from "@/components/ui/Spinner";
import { enableCrossChain, fetchGrantPlan, revokeGrant, saveDelegation, reportGrantDiagnostic } from "@/lib/gateway";
import type { GrantTarget } from "@/lib/gateway";
import { friendlyError } from "@/lib/errors";
import { isSandboxBuild } from "@/lib/mode";

// Exported so the shell can skip the whole "04 Automatic renewal" step rather
// than rendering its heading above nothing. VITE_ vars are inlined at BUILD time,
// so a deployment that forgets this one ships the flag as false — and the failure
// mode should be an absent section, not an empty numbered one that reads as a
// broken page.
/// Retained as a named constant so the removal is legible in blame, but this is
/// no longer a flag: the ERC-7715 grant IS how a subscription is paid. It became
/// mandatory when the Arc-native path was removed — Arc is settlement-only, so
/// there is no other way to collect. While it was still read from
/// VITE_TIER2_DELEGATION, an unset variable hid the only control that can start a
/// payment, and the hosted checkout silently could not take money.
export const TIER2_ENABLED = true;

interface Props {
  sessionId: string;
  sessionToken: string;
  walletAddress: string;
  email?: string;
  emailToken?: string | null;
  /// Named in the wallet's permission prompt.
  merchantName?: string;
  /**
   * Called once every chain is authorized, so the shell can go on to charge from
   * whichever granted chain holds enough USDC.
   */
  /**
   * The chain KEYS now authorized.
   *
   * It took no argument, and the shell's own grantedChains is written only by
   * step 03 — so a subscriber who went straight to this switch authorized
   * every chain and then handed the shell an empty list to look for funds in.
   * Nothing could be found, whatever their balance.
   */
  onAuthorizedAll: (chainKeys: string[]) => void;
}

type State = "checking" | "ineligible" | "ready" | "fallback";

/**
 * The friendly message — plus the real one, in the sandbox only.
 *
 * friendlyError returns an ApiError's own text, so a refusal from our API
 * already explains itself. The generic fallback therefore means the failure
 * was NOT ours: a wallet rejection, a provider that is not there, a chain
 * switch that did not take. Those are the ones that matter here, and the only
 * copy of the cause is a console.error nobody has open.
 *
 * So in test mode the raw message is appended. A payer on mainnet still sees
 * one sentence — their wallet's internal wording is not their problem — but a
 * sandbox is a place to diagnose, and making someone open DevTools to learn
 * why a test failed is a cost with no benefit.
 */
function describeError(e: unknown): string {
  const friendly = friendlyError(e, "We couldn't turn on automatic renewals.");
  if (!isSandboxBuild()) return friendly;
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  // Only when the friendly text is the fallback: an ApiError already said it.
  return raw && !friendly.includes(raw) ? `${friendly} (${raw.slice(0, 220)})` : friendly;
}

/**
 * The design's switch: a 46×24 track with a sliding 18px knob — and a third,
 * middle position for PARTIAL.
 *
 * Two positions could not describe this control. It authorizes several chains at
 * once, and any of them can land while another is declined or fails, so "some are
 * authorized" is a real and common outcome. Rendered as a plain boolean it fell to
 * OFF, identical to having granted nothing, and a subscriber who had just approved
 * two wallet prompts saw a switch that had apparently ignored them.
 *
 * ARIA note: a switch's aria-checked may not be "mixed" (that is a checkbox
 * affordance), so the partial state is carried in the accessible label instead of
 * being faked in the state.
 */
function Switch({
  on,
  partial = false,
  busy,
  onClick,
  label,
}: {
  on: boolean;
  partial?: boolean;
  busy?: boolean;
  onClick: () => void;
  label: string;
}) {
  const knobLeft = on ? 24 : partial ? 13 : 2;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      disabled={busy}
      style={{
        width: 46,
        height: 24,
        background: on
          ? "var(--color-accent)"
          : partial
            // Reads as engaged-but-incomplete rather than as a second "on".
            ? "var(--color-accent-200, var(--color-neutral-400))"
            : "var(--color-neutral-300)",
        border: "1px solid var(--color-divider)",
        cursor: busy ? "wait" : "pointer",
        padding: 0,
        position: "relative",
        flex: "none",
        opacity: busy ? 0.6 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: knobLeft,
          width: 18,
          height: 18,
          background: "var(--color-bg)",
          display: "block",
          transition: "left .16s ease",
        }}
      />
    </button>
  );
}

export function DelegatedRenewalToggle({
  sessionId,
  sessionToken,
  walletAddress,
  email,
  emailToken,
  merchantName,
  onAuthorizedAll,
}: Props) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { data: connectorClient } = useConnectorClient();

  const [state, setState] = useState<State>("checking");
  const [targets, setTargets] = useState<GrantTarget[]>([]);
  /** null = the wallet gave no usable answer; offer every chain rather than none. */
  const [supportedChainIds, setSupportedChainIds] = useState<number[] | null>(null);
  /** Chains currently authorized on-chain. */
  const [granted, setGranted] = useState<number[]>([]);
  /** Chain id mid-grant/revoke, or "all" while the master switch is working. */
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [debugReport, setDebugReport] = useState<string[]>([]);
  /**
   * The chain whose wallet prompt is open, by id rather than by position.
   *
   * Matching a list position went wrong twice over: the index arrived 1-based
   * and was read as a 0-based completed count, so the mark that pulsed was the
   * chain AFTER the one being prompted — a payer saw the chain they had just
   * signed light up. And the walked list is the ungranted subset while the
   * rendered list is every usable chain, so the two diverged again the moment
   * anything was already authorized.
   */
  const [signingChainId, setSigningChainId] = useState<number | null>(null);
  const [error, setError] = useState("");

  // Set for the duration of a grant. grantRenewalMandates switches the wallet's
  // active chain before every grant, which changes both chainId and
  // useConnectorClient() — without this guard that re-fires the effect below
  // mid-loop, resetting state partway through granting.
  const workingRef = useRef(false);

  const refreshPlan = useCallback(async () => {
    const plan = await fetchGrantPlan(sessionId, walletAddress);
    setTargets(plan.targets);
    setGranted(plan.granted_chain_ids ?? []);
    return plan;
  }, [sessionId, walletAddress]);

  useEffect(() => {
    if (workingRef.current) return; // our own chain switches — not a real change
    if (!TIER2_ENABLED || !address || !connectorClient) {
      setState("checking");
      return;
    }
    let cancelled = false;
    (async () => {
      const ids = await getSupportedDelegationChainIds(connectorClient);
      if (cancelled) return;
      /**
       * Logged, because it is the fact that explains a 4100 BEFORE it happens
       * — and the one nobody could see.
       *
       * null means the wallet refused the probe, which is not "cannot grant":
       * the UI then offers every chain and lets the attempt judge,
       * deliberately. But when every chain then fails with "method has not
       * been authorized", this line separates "the wallet never advertised
       * 7715" from "it advertised it and then refused" — different fixes.
       */
      console.info(
        `[grant] wallet advertises 7715 on: ${
          ids === null ? "probe inconclusive — offering every chain" : ids.join(", ") || "no chains"
        }`
      );
      setSupportedChainIds(ids);
      try {
        await refreshPlan();
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) setState("ready");
      }
    })();
    return () => { cancelled = true; };
  }, [address, chainId, connectorClient, refreshPlan]);

  /**
   * The one path that opens the wallet: a smart-account upgrade and an ERC-7715
   * delegation per chain. No permit is involved — Arc is the settlement chain,
   * never a funding one, so there is nothing to sign there.
   */
  /**
   * Returns the chain ids that actually landed, so the caller can act on them.
   *
   * It returned nothing, which left toggleAll unable to tell the shell what
   * had been authorized — and the shell's own list is written only by step
   * 03. An empty return on the early guards is correct: nothing was asked
   * for, so nothing landed.
   */
  async function authorizeAll(
    list: GrantTarget[],
    scope: number | "all"
  ): Promise<number[]> {
    if (!address || !connectorClient || workingRef.current) return [];
    setError("");
    setBusy(scope);
    workingRef.current = true;
    // 1-based once a chain is being asked for; onAttempt sets it.
    setProgress({ done: 1, total: list.length });
    try {
      // One ERC-7715 delegation per chain. A single chain failing never aborts
      // the rest — grantRenewalMandates keeps going and reports what didn't land.
      const failures = list.length === 0
        ? []
        : await grantRenewalMandates(
            walletAddress,
            list,
            (input) => saveDelegation(sessionId, input),
            // onProgress counted chains COMPLETED and wrote the same number the
            // label reads, which is about the chain in hand. Two meanings in one
            // state made the count skip and sometimes go backwards.
            undefined,
            merchantName,
            (info) => {
              setDebugReport((prev) =>
                [...prev, describeGrantFailure({ ...info, walletAddress, advertisedChainIds: supportedChainIds })].slice(-6)
              );
              void reportGrantFailure({
                ...info,
                post: (body) => reportGrantDiagnostic(sessionId, body),
                walletAddress,
                // The probe's answer, which only this component holds, and the
                // one fact separating "the wallet never advertised 7715 for this
                // chain" from "it advertised it and then refused".
                advertisedChainIds: supportedChainIds,
              });
            },
            ({ index, total, chainId }) => {
              setProgress({ done: index, total });
              setSigningChainId(chainId);
            },
          );

      const failedIds = new Set(failures.map((f) => f.target.chain_id));
      const landed = list.filter((t) => !failedIds.has(t.chain_id)).map((t) => t.chain_id);
      if (landed.length > 0) {
        setGranted((prev) => Array.from(new Set([...prev, ...landed])));
        await enableCrossChain(sessionId, {
          session_token: sessionToken,
          wallet_address: walletAddress,
          email,
          email_token: emailToken ?? undefined,
        });
      }

      if (failures.length > 0) {
        const names = failures.map((f) => f.target.name).join(", ");
        /**
         * "Couldn't authorize Base, Arbitrum, OP Mainnet, Monad" said nothing
         * about what to do, and for a wallet that refuses all four there IS
         * something: use another account.
         *
         * Partial is close to fine — delegated-renewal picks one chain per
         * cycle from those that cover the price and hold a full period, so
         * the authorized ones carry renewals on their own. Total means this
         * account cannot grant at all, and cannot be fixed afterwards
         * either: the portal requires the grant to come from the wallet that
         * signed up, which is this one.
         */
        setError(
          landed.length > 0
            ? `Couldn't authorize ${names} — the chains that did succeed cover your renewals.`
            : `This account can't authorize recurring payments on any chain. Try a different ` +
                `account in your wallet, or continue without automatic renewals.`
        );
      }

      return landed;
    } catch (e) {
      setError(describeError(e));
      setState("fallback");
      // Nothing landed that the caller can rely on; the error is already set.
      return [];
    } finally {
      workingRef.current = false;
      setBusy(null);
      setProgress({ done: 0, total: 0 });
      setSigningChainId(null);
    }
  }

  /** Revoke one chain, or every chain when `chainId` is omitted. */
  async function revoke(targetChainId: number | undefined, scope: number | "all") {
    setError("");
    setBusy(scope);
    try {
      await revokeGrant(sessionId, sessionToken, walletAddress, targetChainId);
      setGranted((prev) => (targetChainId === undefined ? [] : prev.filter((id) => id !== targetChainId)));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  if (!TIER2_ENABLED) return null;

  // Chains this wallet can actually authorize. May be empty while the
  // capability probe runs, or if the wallet doesn't speak ERC-7715.
  // An inconclusive probe must not hide the feature — see capabilities.ts.
  const usable = supportedChainIds
    ? targets.filter((t) => supportedChainIds.includes(t.chain_id))
    : targets;
  const probing = state === "checking";
  // The switch has nothing to grant when no chain is usable — but the card
  // still renders, with the reason, because a section that silently disappears
  // reads as a broken page rather than an unavailable option.
  const unusable = !probing && usable.length === 0;

  const grantedUsable = usable.filter((t) => granted.includes(t.chain_id));
  // ON only when every chain it can authorize is granted. PARTIAL whenever some
  // landed but not all — the ordinary result when one chain is declined or its
  // wallet prompt fails, and previously indistinguishable from OFF.
  //
  // There is no Arc permit in this any more: Arc is the settlement chain, not a
  // funding one, so there is nothing to sign there.
  const allOn = usable.length > 0 && grantedUsable.length === usable.length;
  const partiallyOn = !allOn && grantedUsable.length > 0;

  /**
   * The master switch. ON authorizes every chain not already granted — skipping
   * any that is, so a subscriber who approved Base earlier signs only the two
   * that remain — then tells the shell which chains are authorized. It does
   * NOT take the payment: authorizing future renewals and paying today's
   * invoice are two decisions, and step 03 owns the second. It used to pay,
   * which made a grant-only control fail with a balance error. OFF revokes.
   */
  const toggleAll = async () => {
    if (allOn) return void revoke(undefined, "all");
    const asked = usable.filter((t) => !granted.includes(t.chain_id));
    const landed = await authorizeAll(asked, "all");
    /**
     * Everything now authorized, not just what this click added.
     *
     * A subscriber who approved Base earlier and flips this signs only the
     * two that remain, so `landed` alone would omit Base — and Base might be
     * the funded one. The shell needs the whole set to choose from.
     */
    const all7715 = new Set<number>([...granted, ...landed]);
    onAuthorizedAll(usable.filter((t) => all7715.has(t.chain_id)).map((t) => t.chain_key));
  };
  return (
    <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-divider)", padding: 12 }}>
      {/* The master switch — the one control here that authorizes every chain
          at once. Always rendered, whatever the capability probe says. */}
      <div className="flex items-center gap-3">
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 14.5 }}>
          Authorize grant permission for all chains
        </span>
        <span className="ml-auto">
          <Switch
            on={allOn}
            partial={partiallyOn}
            busy={busy === "all" || probing}
            onClick={() => void toggleAll()}
            label={
              partiallyOn
                ? `Authorize the remaining chains — ${grantedUsable.length} of ${usable.length} authorized`
                : "Authorize grant permission for all chains"
            }
          />
        </span>
      </div>

      <p className="m-0" style={{ fontSize: 12, color: "var(--color-neutral-800)", margin: "7px 0 0", lineHeight: 1.5 }}>
        {probing
          ? "Checking which chains your wallet can authorize…"
          : unusable
            ? "This wallet can't authorize renewals on other chains, so renewals will be charged from the chain you pay with today."
            : allOn
              ? "Every supported chain is authorized. Each renewal is charged from whichever one holds enough USDC at the time — choose a chain above to pay today's."
              : partiallyOn
                ? `${grantedUsable.length} of ${usable.length} chains authorized — ${grantedUsable
                    .map((t) => t.name)
                    .join(", ")}. Tap to authorize the rest.`
                : "One signature now to automate renewal on any of the supported chains that holds enough liquidity. We submit each one and pay the gas. Revoke anytime from your wallet."}
      </p>

      {(busy !== null || probing) && (
        <div style={{ marginTop: 10 }}>
          <ActivityBar />
          <p className="m-0 flex items-center gap-2" style={{ fontSize: 12, color: "var(--color-neutral-700)", marginTop: 8 }}>
            <Spinner size={13} />
            {probing
              ? "Checking your wallet…"
              : "Approve each in your wallet."}
          </p>

          {/*
            WHICH CHAIN, shown rather than counted.

            "Signing 2 of 4" asked the payer to hold a number in their head
            and match it against prompts that name chains, not indexes. The
            rail's authorize page had already solved this: it pulses the mark
            of the chain whose prompt is open and dims the ones not started,
            so between dismissing one prompt and the next appearing there is
            something on screen saying where you are.

            progress.done counts COMPLETED signatures, so it indexes the one
            in flight within the same list authorizeAll walked — which is why
            that counter had to start working before this could be built on
            it.
          */}
          {progress.total > 1 && (
            <div className="flex flex-wrap items-center gap-3" style={{ marginTop: 9 }}>
              {usable.map((t) => {
                const on = granted.includes(t.chain_id);
                const inFlight = !on && t.chain_id === signingChainId;
                return (
                  <span key={t.chain_id} className="flex items-center gap-1.5">
                    <span className={inFlight ? "animate-pulse" : undefined}>
                      <ChainMark chain={t.chain_key} size={16} opacity={on ? 1 : inFlight ? 0.75 : 0.3} />
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: on || inFlight ? "var(--color-text)" : "var(--color-neutral-600)",
                        fontWeight: inFlight ? 600 : 400,
                      }}
                    >
                      {t.name}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="m-0" style={{ fontSize: 12, color: "var(--color-accent-700)", marginTop: 10 }}>
          {error}
        </p>
      )}

      {/*
        Diagnostics on the page, only when ?sweepdebug=1 asks for them.

        A subscriber is owed one clear sentence, so this is off by default and
        must stay that way. It exists because reporting a grant failure to the
        server has failed four different ways — an unreadable browser console,
        a preview origin whose POST is refused by CORS, a bundle that may not
        carry the reporter, and a log that can be filtered or scrolled past.
        Rendering it is the one path with nothing in between.
      */}
      {grantDebugEnabled() && debugReport.length > 0 && (
        <pre
          className="m-0"
          style={{
            marginTop: 10,
            padding: 10,
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            userSelect: "all",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--color-text)",
          }}
        >
          {debugReport.join("\n\n")}
        </pre>
      )}

    </div>
  );
}
