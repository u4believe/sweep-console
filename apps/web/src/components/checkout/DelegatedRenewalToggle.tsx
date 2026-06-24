// Proactive "enable cross-chain renewals" — for a subscriber paying on Arc (the
// primary flow) who also wants renewals to fall back to their USDC on other chains
// when their Arc balance runs dry.
//
// It grants an ERC-7715 delegation on each funded SOURCE chain (Base/Arbitrum/
// Optimism Sepolia — Arc is the L1 settlement chain, not a CCTP source, so it's
// never a target). No fee. It does NOT activate: the Arc checkout creates the
// subscription (and the permit/allowance), and links these delegations.
//
// Self-gating: renders only when the feature flag is on AND the wallet advertises
// ERC-7715 support; otherwise it's invisible and checkout proceeds Arc-only.

import { useEffect, useState } from "react";
import { useAccount, useChainId, useConfig, useConnectorClient, useSignTypedData, useSwitchChain } from "wagmi";
import { getChainId } from "wagmi/actions";
import { getSupportedDelegationChainIds } from "@/lib/delegation/capabilities";
import { grantRenewalMandate } from "@/lib/delegation/grant";
import { enableCrossChain, fetchGrantPlan, hydrateTypedData, revokeGrant, saveDelegation, type TypedDataPayload } from "@/lib/gateway";

const TIER2_ENABLED = import.meta.env.VITE_TIER2_DELEGATION === "true";
const MANDATE_LIFETIME_SEC = 31_536_000; // 1 year
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Props {
  sessionId: string;
  sessionToken: string;
  walletAddress: string;
  email?: string;
  emailToken?: string | null;
}

// "dormant" = this wallet already enabled cross-chain renewals for this merchant
// (or this session) → the toggle is hidden entirely.
type State = "checking" | "ineligible" | "ready" | "granting" | "linked" | "fallback" | "dormant";

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user storage|gator_7715|Failed to fetch/i.test(msg)) {
    return "MetaMask couldn't reach its permission storage. Turn on Settings → Backup and sync in MetaMask, make sure you're signed in and online, then try again.";
  }
  if (/rejected|denied|cancell?ed/i.test(msg)) return "Request cancelled. You can enable this anytime.";
  return msg || "Could not enable cross-chain renewals";
}

export function DelegatedRenewalToggle({ sessionId, sessionToken, walletAddress, email, emailToken }: Props) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { data: connectorClient } = useConnectorClient();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const wagmiConf = useConfig();
  const [state, setState] = useState<State>("checking");
  const [supportedChainIds, setSupportedChainIds] = useState<number[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState(false);

  const shortWallet = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;

  const onRevoke = async () => {
    setError("");
    setRevoking(true);
    try {
      await revokeGrant(sessionId, sessionToken, walletAddress);
      setState("ready"); // grant cleared — offer it again
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRevoking(false);
    }
  };

  useEffect(() => {
    if (!TIER2_ENABLED || !address || !connectorClient) {
      setState("checking");
      return;
    }
    let cancelled = false;
    (async () => {
      const ids = await getSupportedDelegationChainIds(connectorClient);
      if (cancelled) return;
      setSupportedChainIds(ids);
      if (ids.length === 0) {
        setState("ineligible");
        return;
      }
      // Already enabled for this wallet (this session, or a prior subscription
      // with this merchant)? Hide the offer entirely — never re-show it to a
      // wallet that already granted.
      try {
        const plan = await fetchGrantPlan(sessionId, walletAddress);
        if (cancelled) return;
        setState(plan.already_enabled ? "dormant" : "ready");
      } catch {
        if (!cancelled) setState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, chainId, connectorClient, sessionId, walletAddress]);

  const signOnChain = async (cid: number, payload: TypedDataPayload): Promise<string> => {
    if (getChainId(wagmiConf) !== cid) {
      await switchChainAsync({ chainId: cid });
      for (let i = 0; i < 40 && getChainId(wagmiConf) !== cid; i++) await sleep(150);
    }
    const hydrated = hydrateTypedData(payload) as never;
    for (let attempt = 0; ; attempt++) {
      try {
        return await signTypedDataAsync(hydrated);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (attempt < 6 && /does not match the connection|ConnectorChainMismatch|must match the active chain/.test(m)) {
          await switchChainAsync({ chainId: cid }).catch(() => {});
          await sleep(250);
          continue;
        }
        throw e;
      }
    }
  };

  const onEnable = async () => {
    if (!address || !connectorClient) return;
    setError("");
    setState("granting");
    try {
      const plan = await fetchGrantPlan(sessionId, walletAddress);
      const targets = plan.targets.filter((t) => supportedChainIds.includes(t.chain_id));
      if (targets.length === 0) {
        setError("You need USDC on a supported chain (Base, Arbitrum, or Optimism Sepolia) your wallet can authorize.");
        setState("fallback");
        return;
      }
      setProgress({ done: 0, total: targets.length });

      // One ERC-7715 delegation per funded source chain. No fee — the platform
      // covers gas + bridge from the 2% fee on each charge.
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
          justification: `Cross-chain renewals on ${t.name} when your Arc balance is low — capped to one period each cycle, revocable anytime.`,
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
        setProgress((p) => ({ done: p.done + 1, total: p.total }));
      }

      await enableCrossChain(sessionId, {
        session_token: sessionToken,
        wallet_address: walletAddress,
        email,
        email_token: emailToken ?? undefined,
      });
      setState("linked");
    } catch (e) {
      setError(describeError(e));
      setState("fallback");
    }
  };

  if (!TIER2_ENABLED || state === "checking" || state === "ineligible" || state === "dormant") return null;

  if (state === "linked") {
    // Compact: just the connected wallet + a Revoke button — keeps the card short.
    return (
      <div>
        <div className="flex items-center justify-between gap-2 rounded-lg bg-brand-50 px-3 py-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-brand-700">
            <span className="text-brand-600">✓</span>
            <span className="truncate">
              Cross-chain renewals on · <span className="font-mono">{shortWallet}</span>
            </span>
          </span>
          <button
            onClick={onRevoke}
            disabled={revoking}
            className="shrink-0 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            {revoking ? "Revoking…" : "Revoke"}
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  if (state === "fallback") {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
        <p className="text-sm font-medium text-gray-800">Couldn't enable cross-chain renewals</p>
        <p className="mt-0.5 text-xs text-gray-500">{error}</p>
        <p className="mt-1 text-xs text-gray-400">
          No problem — you can still subscribe on Arc. Renewals will bill from your Arc balance.
        </p>
        <button onClick={onEnable} className="mt-2 text-sm font-medium text-brand-600 hover:underline">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3">
      <p className="text-sm font-medium text-gray-800">Auto-renew from other chains if Arc runs low</p>
      <p className="mt-0.5 text-xs text-gray-500">
        Optional: authorize once so renewals can fall back to your USDC on Base, Arbitrum, or
        Optimism when your Arc balance is short. No extra fee — gas and bridge costs are on us.
      </p>
      <button
        onClick={onEnable}
        disabled={state === "granting"}
        className="mt-3 w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
      >
        {state === "granting"
          ? progress.total
            ? `Authorizing ${progress.done}/${progress.total}…`
            : "Preparing…"
          : "Enable cross-chain renewals"}
      </button>
    </div>
  );
}
