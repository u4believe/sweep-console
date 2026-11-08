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
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
import { Spinner, ActivityBar } from "@/components/ui/Spinner";
import { enableCrossChain, fetchGrantPlan, revokeGrant, saveDelegation } from "@/lib/gateway";
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
    setProgress({ done: 0, total: list.length });
    try {
      // One ERC-7715 delegation per chain. A single chain failing never aborts
      // the rest — grantRenewalMandates keeps going and reports what didn't land.
      const failures = list.length === 0
        ? []
        : await grantRenewalMandates(
            walletAddress,
            list,
            (input) => saveDelegation(sessionId, input),
            (done, total) => setProgress({ done, total }),
            merchantName
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
        setError(
          landed.length > 0
            ? `Couldn't authorize ${names} — the chains that did succeed are active.`
            : `Couldn't authorize ${names}.`
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
              : progress.total > 1
                ? `Signing ${progress.done + 1} of ${progress.total} — approve each in your wallet.`
                : "Approve in your wallet to authorize."}
          </p>
        </div>
      )}

      {error && (
        <p className="m-0" style={{ fontSize: 12, color: "var(--color-accent-700)", marginTop: 10 }}>
          {error}
        </p>
      )}

    </div>
  );
}
