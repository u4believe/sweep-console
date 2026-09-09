// "Automatic renewal" — for a subscriber paying on Arc (the primary flow) who
// also wants renewals to fall back to their USDC on other chains when their Arc
// balance runs dry.
//
// ONE switch, and it means "all chains".
//
// Chain selection lives in step 03 ("Pay from") — it is the only picker on this
// page, so this component deliberately has no chain rows of its own. Two lists
// of the same four chains, each with its own notion of what was chosen, is how
// a subscriber ends up unsure which one is authorizing anything.
//
// Off (the default): renewals are authorized only for the chain picked in 03,
// and that grant is signed when the subscriber presses "Sign in wallet &
// subscribe" — not a moment earlier. Arc needs no grant at all; it rides the
// ERC-2612 permit.
//
// On: every supported chain is authorized in one run — the Arc permit, then a
// 7702 smart-account upgrade plus an ERC-7715 delegation on each of
// Base/Arbitrum/Optimism. This is the only control here that opens the wallet.
//
// Turning it back off revokes every grant. Revocation is a server call against
// the stored delegation, so it needs no signature.
//
// Self-gating: renders only when the feature flag is on AND the wallet advertises
// ERC-7715 support; otherwise it's invisible and checkout proceeds Arc-only.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useConnectorClient } from "wagmi";
import { getSupportedDelegationChainIds } from "@/lib/delegation/capabilities";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";
import { enableCrossChain, fetchGrantPlan, revokeGrant, saveDelegation } from "@/lib/gateway";
import type { GrantTarget } from "@/lib/gateway";

// Exported so the shell can skip the whole "04 Automatic renewal" step rather
// than rendering its heading above nothing. VITE_ vars are inlined at BUILD time,
// so a deployment that forgets this one ships the flag as false — and the failure
// mode should be an absent section, not an empty numbered one that reads as a
// broken page.
export const TIER2_ENABLED = import.meta.env.VITE_TIER2_DELEGATION === "true";

interface Props {
  sessionId: string;
  sessionToken: string;
  walletAddress: string;
  email?: string;
  emailToken?: string | null;
  /** Signs (or returns the already-signed) Arc EIP-2612 permit. */
  signArcPermit: () => Promise<unknown>;
  /** True once that permit exists, whoever collected it. */
  arcPermitSigned: boolean;
  /**
   * Called once every chain is authorized, so the shell can go on to charge —
   * Arc first, then whichever approved chain holds enough USDC.
   */
  onAuthorizedAll: () => void;
}

type State = "checking" | "ineligible" | "ready" | "fallback";

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user storage|gator_7715|Failed to fetch/i.test(msg)) {
    return "MetaMask couldn't reach its permission storage. Turn on Settings → Backup and sync in MetaMask, make sure you're signed in and online, then try again.";
  }
  if (/rejected|denied|cancell?ed/i.test(msg)) return "Request cancelled. You can enable this anytime.";
  return msg || "Could not enable cross-chain renewals";
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
  signArcPermit,
  arcPermitSigned,
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
   * The one path that opens the wallet. Arc's permit first (it covers the
   * opening charge as well, so it must exist before anything else is signed),
   * then upgrade + delegation on every other chain.
   */
  async function authorizeAll(list: GrantTarget[], scope: number | "all") {
    if (!address || !connectorClient || workingRef.current) return;
    setError("");
    setBusy(scope);
    workingRef.current = true;
    setProgress({ done: 0, total: list.length });
    try {
      // Arc: ERC-2612 permit. Signed once per checkout and shared with the pay
      // button, so a subscriber who authorizes here never signs it twice.
      if (!arcPermitSigned) await signArcPermit();

      // One ERC-7715 delegation per chain. A single chain failing never aborts
      // the rest — grantRenewalMandates keeps going and reports what didn't land.
      const failures = list.length === 0
        ? []
        : await grantRenewalMandates(
            walletAddress,
            list,
            (input) => saveDelegation(sessionId, input),
            (done, total) => setProgress({ done, total })
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
    } catch (e) {
      setError(describeError(e));
      setState("fallback");
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
  // ON only when everything it authorizes is in place: every chain granted AND
  // Arc's permit signed. PARTIAL whenever some of that landed but not all — the
  // ordinary result when one chain is declined or its wallet prompt fails, and
  // previously indistinguishable from OFF. It also covers every chain being
  // granted while the Arc permit is still outstanding.
  const allOn = usable.length > 0 && grantedUsable.length === usable.length && arcPermitSigned;
  const partiallyOn = !allOn && grantedUsable.length > 0;

  /**
   * The master switch. ON authorizes every chain not already granted — skipping
   * any that is, so a subscriber who approved Base earlier signs only the two
   * that remain — then hands back to the shell to take the payment. OFF revokes.
   */
  const toggleAll = async () => {
    if (allOn) return void revoke(undefined, "all");
    await authorizeAll(usable.filter((t) => !granted.includes(t.chain_id)), "all");
    onAuthorizedAll();
  };

  return (
    <div style={{ background: "var(--color-surface)", border: "2px solid var(--color-divider)", padding: 12 }}>
      {/* The master switch — the one control here that authorizes every chain
          at once. Always rendered, whatever the capability probe says. */}
      <div className="flex items-center gap-3">
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 14.5 }}>
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
            ? "This wallet can't authorize renewals on other chains. Renewals are charged from Arc, covered by the payment you sign."
            : allOn
              ? "Every supported chain is authorized. If your Arc balance runs dry, we'll charge the renewal from whichever chain has USDC."
              : partiallyOn
                ? `${grantedUsable.length} of ${usable.length} chains authorized — ${grantedUsable
                    .map((t) => t.name)
                    .join(", ")}. Tap to authorize the rest.`
                : "One signature now to automate renewal on any of the supported chains that holds enough liquidity. We submit each one and pay the gas. Revoke anytime from your wallet."}
      </p>

      {progress.total > 1 && busy !== null && (
        <p className="m-0" style={{ fontSize: 12, color: "var(--color-neutral-700)", marginTop: 10 }}>
          Signing {progress.done + 1} of {progress.total} — approve each in your wallet.
        </p>
      )}

      {error && (
        <p className="m-0" style={{ fontSize: 12, color: "var(--color-accent-700)", marginTop: 10 }}>
          {error}
        </p>
      )}

    </div>
  );
}
