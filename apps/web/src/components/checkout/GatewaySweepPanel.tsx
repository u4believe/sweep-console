import { useEffect, useRef, useState } from "react";
import { useConfig, useConnectorClient, useSignTypedData, useSwitchChain } from "wagmi";
import { getChainId } from "wagmi/actions";
import {
  activateCrossChain,
  fetchGrantPlan,
  fetchSweepStatus,
  hydrateTypedData,
  saveDelegation,
  type GrantPlan,
  type GrantTarget,
  type TypedDataPayload,
} from "@/lib/gateway";
import { getSupportedDelegationChainIds } from "@/lib/delegation/capabilities";
import { grantRenewalMandates } from "@/lib/delegation/grantMandates";

/**
 * Does this wallet already hold a renewal mandate on any chain?
 *
 * The sweep bridges from a single chain, so one mandate is sufficient — unlike
 * the renewal toggle, which tracks each chain separately.
 */
function hasAnyGrant(plan: { granted_chain_ids?: number[]; already_enabled: boolean }): boolean {
  return (plan.granted_chain_ids?.length ?? 0) > 0 || plan.already_enabled;
}

// Cross-chain checkout via CCTP V2 (delegation-gated).
//
// Arc is primary; this panel is the Arc-SHORT path. Enabling cross-chain is a
// one-time setup: the subscriber signs (1) an ERC-7715 delegation per funded source
// chain and (2) the Arc permit — no fee. The platform then funds + activates the
// subscription from a source chain via CCTP — covering gas + bridge fees, so the
// subscriber is charged only the exact subscription amount.

interface Props {
  sessionId: string;
  sessionToken: string;
  walletAddress: string;
  email?: string;
  emailToken?: string | null;
  /**
   * `sourceChain` is the chain the funds were actually pulled from, for the
   * receipt; `subscriptionId` is what the confirmation page's renewal permissions
   * bind to, since the checkout session is spent by the time this fires.
   */
  onSuccess: (
    txHash: string | null,
    sourceChain: string | null,
    subscriptionId: string | null
  ) => void;
  onClose: () => void;
  /**
   * Run as soon as the plan is ready, without waiting for a Confirm click.
   * The chain rows in "Pay from" are themselves the pay action now, so a second
   * confirmation inside this panel would be a click the subscriber already made.
   */
  autoStart?: boolean;
  /**
   * The chain the subscriber picked in "Pay from" (a GrantTarget.chain_key).
   * Granting is narrowed to it, so picking Base authorizes Base and nothing
   * else. Omit — or pass a chain this wallet can't grant on — to fall back to
   * every supported chain.
   */
  preferredChainKey?: string;
}

type Phase = "planning" | "review" | "signing" | "executing" | "insufficient" | "error";

const POLL_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Map noisier wallet-side ERC-7715 failures to guidance the subscriber can act on.
function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user storage|gator_7715|Failed to fetch/i.test(msg)) {
    return "MetaMask couldn't reach its permission storage. Turn on Settings → Backup and sync in MetaMask, make sure you're signed in and online, then try again.";
  }
  if (/rejected|denied|cancell?ed/i.test(msg)) return "Request cancelled.";
  if (/not supported/i.test(msg)) return "Your wallet can't authorize on this chain.";
  return msg || "Could not enable cross-chain payment";
}

export function GatewaySweepPanel({
  sessionId, sessionToken, walletAddress, email, emailToken, onSuccess, onClose, preferredChainKey,
  autoStart = false,
}: Props) {
  const { data: connectorClient } = useConnectorClient();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const wagmiConf = useConfig();
  const [phase, setPhase] = useState<Phase>("planning");
  const [plan, setPlan] = useState<GrantPlan | null>(null);
  const [targets, setTargets] = useState<GrantTarget[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set for the duration of onApprove. grantRenewalMandates switches the wallet's
  // active chain before every grant, which changes what useConnectorClient()
  // returns — without this guard that re-fires the effect below mid-loop,
  // stomping the in-progress UI and racing its own wallet RPC call against the
  // grant loop's pending one (this is what silently killed grants after the
  // first chain).
  const approvingRef = useRef(false);

  const loadPlan = async () => {
    setPhase("planning");
    setErrorMsg("");
    try {
      const p = await fetchGrantPlan(sessionId, walletAddress);
      setPlan(p);
      // Any existing mandate is enough for the sweep: we bridge from ONE chain,
      // so there is nothing to re-grant. (Note this is deliberately not
      // `already_enabled`, which means every chain is authorized — a stricter
      // condition that would wrongly send a partially-granted wallet back
      // through granting just to pay.)
      if (hasAnyGrant(p)) {
        setPhase("review");
        return;
      }
      // Fresh enable — request only on chains the wallet supports ERC-7715 for.
      const supported = connectorClient ? await getSupportedDelegationChainIds(connectorClient) : null;
      // null ⇒ inconclusive probe; offer every target and let the grant decide.
      const usable = supported ? p.targets.filter((t) => supported.includes(t.chain_id)) : p.targets;

      // Honour the "Pay from" pick: one chain was chosen, so ask for one grant.
      // Falling back to the full set when the pick isn't grantable keeps a
      // wallet that can't authorize Base from dead-ending with nothing to sign.
      const picked = preferredChainKey
        ? usable.filter((t) => t.chain_key === preferredChainKey)
        : [];
      const chosen = picked.length > 0 ? picked : usable;

      setTargets(chosen);
      setPhase(chosen.length === 0 ? "insufficient" : "review");
    } catch (e) {
      setErrorMsg(describeError(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    if (approvingRef.current) return; // our own chain switches during granting — not a real change
    loadPlan();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorClient, preferredChainKey]);

  // Auto-run once, as soon as there is something to run. `approvingRef` keeps
  // the chain-switching inside onApprove from re-triggering this mid-flight.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    if (phase !== "review") return;
    autoStartedRef.current = true;
    void onApprove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, phase]);

  const startPolling = (id: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const s = await fetchSweepStatus(sessionId, id);
        if (s.status === "complete") {
          if (pollRef.current) clearInterval(pollRef.current);
          onSuccess(s.activation_tx_hash, s.source_chain, s.subscription_id);
        } else if (s.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setErrorMsg(s.error ?? "The activation failed");
          setPhase("error");
        }
      } catch {
        /* transient poll error — keep trying */
      }
    }, POLL_MS);
  };

  // Switch to `chainId` and WAIT for the connector to report it before signing —
  // signTypedData validates the payload's domain.chainId against the active chain.
  const signOnChain = async (chainId: number, payload: TypedDataPayload): Promise<string> => {
    if (getChainId(wagmiConf) !== chainId) {
      await switchChainAsync({ chainId });
      for (let i = 0; i < 40 && getChainId(wagmiConf) !== chainId; i++) await sleep(150);
    }
    const hydrated = hydrateTypedData(payload) as never;
    for (let attempt = 0; ; attempt++) {
      try {
        return await signTypedDataAsync(hydrated);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < 6 && /does not match the connection|ConnectorChainMismatch|must match the active chain/.test(msg)) {
          await switchChainAsync({ chainId }).catch(() => {});
          await sleep(250);
          continue;
        }
        throw e;
      }
    }
  };

  const onApprove = async () => {
    if (!plan || approvingRef.current) return;
    const enabled = hasAnyGrant(plan);
    // Fresh enable needs grants (and a 7715-capable wallet).
    if (!enabled && (!connectorClient || targets.length === 0)) return;
    setErrorMsg("");
    setPhase("signing");
    approvingRef.current = true;

    try {
      if (!enabled && connectorClient) {
        // One ERC-7715 delegation per supported source chain, saved server-side.
        // No fee — the platform covers gas + bridge from the 2% fee on each
        // charge. Shared loop — switches the wallet to each target chain before
        // requesting its grant, and keeps going even if one chain fails; the
        // actual payment below just needs ONE granted chain with funds.
        await grantRenewalMandates(walletAddress, targets, (input) =>
          saveDelegation(sessionId, input)
        );
      }

      // Final — Arc permit (recurring allowance + activation escrow). Always signed.
      const permitChainId = Number(plan.permit_payload.domain.chainId);
      const permitSignature = await signOnChain(permitChainId, plan.permit_payload);

      const { sweep_id } = await activateCrossChain(sessionId, {
        session_token: sessionToken,
        wallet_address: walletAddress,
        email,
        email_token: emailToken ?? undefined,
        permit_signature: permitSignature,
        permit_value: plan.permit_value,
        permit_deadline: plan.permit_deadline,
      });

      setPhase("executing");
      startPolling(sweep_id);
    } catch (e) {
      setErrorMsg(describeError(e));
      setPhase("error");
    } finally {
      approvingRef.current = false;
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Pay from other chains</h3>
        {(phase === "review" || phase === "insufficient" || phase === "error") && (
          <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">
            Close
          </button>
        )}
      </div>

      {phase === "planning" && <p className="text-sm text-gray-500">Scanning your USDC across chains…</p>}

      {phase === "insufficient" && (
        <div className="space-y-2">
          <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
            Cross-chain isn't available: your wallet can't authorize renewals on any of the
            supported chains (Base, Arbitrum, or Optimism Sepolia).
          </p>
          <button onClick={loadPlan} className="text-sm text-brand-600 hover:underline">
            Try again
          </button>
        </div>
      )}

      {/* Already authorized: nothing is being asked of the subscriber here, so
          this reads as a status, not a request. The panel auto-runs (autoStart) —
          the only confirmation is the wallet's own, which is already on screen by
          the time anyone could reach for a button. Rendering "Confirm & Pay"
          alongside a live wallet prompt asked them to confirm twice and left a
          control that did nothing if they pressed it. It is kept only for the
          manual case, which every current caller opts out of. */}
      {phase === "review" && plan && hasAnyGrant(plan) && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            We&apos;re processing your payment for this checkout on the enabled chain — no
            re-authorizing needed.
          </p>
          <p className="text-xs text-gray-400">One gasless signature (the Arc approval).</p>
          {autoStart ? (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
              <span>Confirm in your wallet…</span>
            </div>
          ) : (
            <button onClick={onApprove} className="btn-primary w-full py-3">
              Confirm &amp; Pay
            </button>
          )}
        </div>
      )}

      {phase === "review" && plan && !hasAnyGrant(plan) && targets.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Enable cross-chain once and we'll handle every charge on Arc, pulling from your USDC on
            other chains when your Arc balance runs low. No extra fee — gas and bridge costs are on us.
          </p>
          <ul className="space-y-1 rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-600">
            <li>• Authorize renewals on: {targets.map((t) => t.name).join(", ")}</li>
            <li>• Then your subscription activates on Arc — you're charged the exact amount only</li>
          </ul>
          <p className="text-xs text-gray-400">
            {targets.length + 1} gasless signatures: one per chain you authorize, and the Arc approval.
          </p>
          {autoStart ? (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
              <span>Confirm in your wallet…</span>
            </div>
          ) : (
            <button onClick={onApprove} className="btn-primary w-full py-3">
              Enable &amp; Pay
            </button>
          )}
        </div>
      )}

      {phase === "signing" && (
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
          <span>Processing your payment…</span>
        </div>
      )}

      {phase === "executing" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-gray-700">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
            <span>Processing your payment…</span>
          </div>
          <p className="text-xs text-gray-400">This can take up to a minute — please keep this page open.</p>
        </div>
      )}

      {phase === "error" && (
        <div className="space-y-2">
          <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{errorMsg}</p>
          <button onClick={loadPlan} className="btn-primary w-full py-2 text-sm">
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
