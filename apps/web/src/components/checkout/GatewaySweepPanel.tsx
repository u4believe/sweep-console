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
import { grantRenewalMandate } from "@/lib/delegation/grant";

// Cross-chain checkout via CCTP V2 (delegation-gated).
//
// Arc is primary; this panel is the Arc-SHORT path. Enabling cross-chain is a
// one-time setup: the subscriber signs (1) an ERC-7715 delegation per funded source
// chain and (2) the Arc permit — no fee. The platform then funds + activates the
// subscription from a source chain via CCTP — covering gas + bridge fees, so the
// subscriber is charged only the exact subscription amount.

const MANDATE_LIFETIME_SEC = 31_536_000; // 1 year

interface Props {
  sessionId: string;
  sessionToken: string;
  walletAddress: string;
  email?: string;
  emailToken?: string | null;
  onSuccess: (txHash: string | null) => void;
  onClose: () => void;
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

export function GatewaySweepPanel({ sessionId, sessionToken, walletAddress, email, emailToken, onSuccess, onClose }: Props) {
  const { data: connectorClient } = useConnectorClient();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const wagmiConf = useConfig();
  const [phase, setPhase] = useState<Phase>("planning");
  const [plan, setPlan] = useState<GrantPlan | null>(null);
  const [targets, setTargets] = useState<GrantTarget[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadPlan = async () => {
    setPhase("planning");
    setErrorMsg("");
    try {
      const p = await fetchGrantPlan(sessionId, walletAddress);
      setPlan(p);
      // Already enabled (grants exist from a prior enable): no re-granting — just
      // confirm to activate with the Arc permit.
      if (p.already_enabled) {
        setPhase("review");
        return;
      }
      // Fresh enable — request only on chains the wallet supports ERC-7715 for.
      const supported = connectorClient ? await getSupportedDelegationChainIds(connectorClient) : [];
      const usable = p.targets.filter((t) => supported.includes(t.chain_id));
      setTargets(usable);
      setPhase(usable.length === 0 ? "insufficient" : "review");
    } catch (e) {
      setErrorMsg(describeError(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    loadPlan();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorClient]);

  const startPolling = (id: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const s = await fetchSweepStatus(sessionId, id);
        if (s.status === "complete") {
          if (pollRef.current) clearInterval(pollRef.current);
          onSuccess(s.activation_tx_hash);
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
    if (!plan) return;
    const enabled = plan.already_enabled;
    // Fresh enable needs grants (and a 7715-capable wallet).
    if (!enabled && (!connectorClient || targets.length === 0)) return;
    setErrorMsg("");
    setPhase("signing");

    try {
      if (!enabled && connectorClient) {
        // One ERC-7715 delegation per funded source chain, saved server-side. No
        // fee — the platform covers gas + bridge from the 2% fee on each charge.
        const now = Math.floor(Date.now() / 1000);
        for (const t of targets) {
          const mandate = await grantRenewalMandate(connectorClient, {
            chainId: t.chain_id,
            token: t.token,
            delegate: t.delegate,
            periodAmountMicro: BigInt(t.period_amount),
            periodDurationSec: t.period_duration,
            startTimeSec: now,
            expirySec: now + MANDATE_LIFETIME_SEC,
            justification: `Cross-chain subscription renewals on ${t.name} — capped to one period each cycle, revocable anytime.`,
          });
          await saveDelegation(sessionId, {
            wallet_address: walletAddress,
            account_address: mandate.accountAddress,
            delegate_address: t.delegate,
            chain_id: t.chain_id,
            token: t.token,
            delegation_manager: mandate.delegationManager,
            context: mandate.context,
            dependencies: mandate.dependencies,
            period_amount: t.period_amount,
            period_duration: t.period_duration,
            expiry: mandate.expirySec,
          });
        }
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
            Cross-chain isn't available: you need USDC on a supported chain (Base, Arbitrum, or
            Optimism Sepolia) your wallet can authorize.
          </p>
          <button onClick={loadPlan} className="text-sm text-brand-600 hover:underline">
            Re-check balances
          </button>
        </div>
      )}

      {phase === "review" && plan && plan.already_enabled && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Cross-chain is already enabled for this checkout — no re-authorizing.
            Confirm to pay from a chain with funds; we'll bridge it to Arc.
          </p>
          <p className="text-xs text-gray-400">One gasless signature (the Arc approval).</p>
          <button onClick={onApprove} className="btn-primary w-full py-3">
            Confirm &amp; Pay
          </button>
        </div>
      )}

      {phase === "review" && plan && !plan.already_enabled && targets.length > 0 && (
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
          <button onClick={onApprove} className="btn-primary w-full py-3">
            Enable &amp; Pay
          </button>
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
