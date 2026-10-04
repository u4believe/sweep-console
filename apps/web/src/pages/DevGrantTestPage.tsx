// DEV-ONLY harness (route gated by import.meta.env.DEV).
//
// Validates the C1 renewal primitive: the subscriber grants an ERC-7715 periodic
// permission (one capped transfer per period), and the relayer redeems it as a
// single `transfer(recipient, amount)`. Cross-chain settlement then happens
// off-delegation: the relayer bridges its received funds via CCTP to Arc.
//
// Flow: connect a 7715-capable wallet (MetaMask Flask) → 1 · Grant → inspect the
// decoded caveats → 2 · Test redeem (server simulates the single transfer to the
// relayer; `ok:true` = the mandate redeems). Nothing here moves funds.

import { useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useConnectorClient } from "wagmi";
import { erc7715ProviderActions } from "@metamask/smart-accounts-kit/actions";
import { decodeAbiParameters, type Hex } from "viem";
import { grantRenewalMandate } from "@/lib/delegation/grant";
import { ensureSmartAccount } from "@/lib/delegation/upgrade";
import { friendlyError } from "@/lib/errors";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const DEFAULT_DELEGATE = (import.meta.env.VITE_RENEWAL_DELEGATE_ADDRESS as string) ?? "";
// USDC per chain, so switching the wallet's network does not silently leave the
// token pointing at another chain's address — a grant against a token that does
// not exist there fails in a way that looks like the chain is unsupported.
const USDC_BY_CHAIN: Record<number, string> = {
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",   // Base Sepolia
  421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",  // Arbitrum Sepolia
  11155420: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", // OP Sepolia
  5042002: "0x3600000000000000000000000000000000000000",  // Arc testnet
};
const DEFAULT_TOKEN = USDC_BY_CHAIN[84532]!;

// ERC-7710 Delegation[] — MetaMask's permissionsContext encoding.
const DELEGATION_TUPLE = [
  {
    type: "tuple[]",
    components: [
      { name: "delegate", type: "address" },
      { name: "delegator", type: "address" },
      { name: "authority", type: "bytes32" },
      {
        name: "caveats",
        type: "tuple[]",
        components: [
          { name: "enforcer", type: "address" },
          { name: "terms", type: "bytes" },
          { name: "args", type: "bytes" },
        ],
      },
      { name: "salt", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

export function DevGrantTestPage() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { data: connectorClient } = useConnectorClient();

  const [token, setToken] = useState(DEFAULT_TOKEN);
  const [tokenTouched, setTokenTouched] = useState(false);
  const [delegate, setDelegate] = useState(DEFAULT_DELEGATE);
  const [amount, setAmount] = useState("1000000"); // 1 USDC
  const [period, setPeriod] = useState("2592000"); // 30 days

  const [rawGrant, setRawGrant] = useState("");
  const [caveats, setCaveats] = useState<{ enforcer: string; terms: string }[] | null>(null);
  const [context, setContext] = useState<Hex | null>(null);
  const [delegationManager, setDelegationManager] = useState<string | null>(null);
  const [redeemResult, setRedeemResult] = useState("");
  /// What the wallet says it supports — see onProbeRules.
  const [ruleProbe, setRuleProbe] = useState("");
  const [error, setError] = useState("");

  // Real CCTP bridge (moves funds).
  const [bridgeSpeed, setBridgeSpeed] = useState<"standard" | "fast">("standard");
  const [burnTx, setBurnTx] = useState<{ hash: string; domain: number } | null>(null);
  const [bridgeMsg, setBridgeMsg] = useState("");
  const [bridgeErr, setBridgeErr] = useState("");

  // Integration run (seed a due sub + run the pass).
  const [creator, setCreator] = useState("");
  const [grantedAmount, setGrantedAmount] = useState(""); // amount baked into the last grant
  const [intgMsg, setIntgMsg] = useState("");
  const [runResult, setRunResult] = useState("");
  const [intgErr, setIntgErr] = useState("");

  /**
   * Ask the wallet which permission types and RULE types it supports.
   *
   * The rule we care about is "payee". The periodic permission's own data pins
   * the token, the amount and the period — and nothing about where the money
   * goes, so a stolen delegate key can redeem to any address it likes. A payee
   * rule is the only thing in ERC-7715 that would bound the destination, and
   * the kit maps it to an AllowedCalldataEnforcer caveat that pins the
   * recipient bytes of the transfer.
   *
   * Worth probing rather than assuming, because the failure is silent: the kit
   * will happily send a payee rule to a wallet that ignores it, and the grant
   * comes back looking fine while constraining nothing.
   */
  const onProbeRules = async () => {
    setError("");
    setRuleProbe("");
    if (!connectorClient) {
      setError("Connect a wallet first.");
      return;
    }
    try {
      const provider = connectorClient.extend(erc7715ProviderActions());
      const supported = await provider.getSupportedExecutionPermissions();
      const lines: string[] = [];
      for (const [type, info] of Object.entries(supported ?? {})) {
        const i = info as { chainIds?: number[]; ruleTypes?: string[] };
        const rules = i.ruleTypes ?? [];
        lines.push(
          `${type}\n  chains: ${(i.chainIds ?? []).join(", ") || "—"}\n  rules:  ${rules.join(", ") || "(none)"}`
        );
      }
      const periodic = (supported as Record<string, { ruleTypes?: string[] }>)?.["erc20-token-periodic"];
      const payee = periodic?.ruleTypes?.includes("payee");
      lines.push(
        payee === undefined
          ? "\nVERDICT: this wallet did not report erc20-token-periodic at all."
          : payee
            ? "\nVERDICT: payee IS supported — the recipient can be pinned on new grants."
            : "\nVERDICT: payee is NOT supported — a payee rule would be sent and silently ignored."
      );
      setRuleProbe(lines.join("\n\n"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Keep the token in step with the wallet's network until someone types their
  // own. Without this, testing Arc while the field still holds Base's USDC fails
  // on a missing token and reads as "Arc does not support permissions".
  useEffect(() => {
    if (tokenTouched) return;
    const t = USDC_BY_CHAIN[chainId];
    if (t) setToken(t);
  }, [chainId, tokenTouched]);

  const onGrant = async () => {
    setError(""); setRawGrant(""); setCaveats(null); setContext(null); setRedeemResult("");
    if (!address || !connectorClient) { setError("Connect a wallet first"); return; }

    // The real grant flow upgrades the account on this chain first (grantMandates.ts).
    // Skipping it here would make a wallet refusal look like "this chain cannot host
    // an ERC-7715 permission", which is exactly the question this harness is used to
    // answer. No-op when the account is already a smart account on this chain.
    try {
      await ensureSmartAccount(connectorClient, address, chainId);
    } catch (e) {
      setError(`EIP-7702 upgrade failed on chain ${chainId}: ${friendlyError(e, "the wallet refused the upgrade")}`);
      return;
    }
    try {
      const now = Math.floor(Date.now() / 1000);
      const mandate = await grantRenewalMandate(connectorClient, {
        chainId,
        token: token as `0x${string}`,
        delegate: delegate as `0x${string}`,
        periodAmountMicro: BigInt(amount),
        periodDurationSec: Number(period),
        startTimeSec: now,
        expirySec: now + 31_536_000,
        justification: "Grant-test harness — verifying periodic-transfer redeem.",
      });

      setRawGrant(
        JSON.stringify(mandate.raw, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
      );
      setContext(mandate.context);
      setDelegationManager(mandate.delegationManager);
      setGrantedAmount(amount); // the period cap baked into this grant — seed must match it

      // Decode caveats from the context (which enforcer is attached?).
      try {
        const [delegations] = decodeAbiParameters(DELEGATION_TUPLE, mandate.context);
        const cs = (delegations as readonly { caveats: readonly { enforcer: string; terms: string }[] }[])
          .flatMap((d) => d.caveats)
          .map((c) => ({ enforcer: c.enforcer, terms: c.terms }));
        setCaveats(cs);
      } catch {
        setCaveats(null); // encoding differs — read the raw response above
      }
    } catch (e) {
      setError(friendlyError(e, "Grant failed (need MetaMask Flask?)"));
    }
  };

  // Simulate the C1 redeem: relayer redeems the mandate as transfer(relayer, amount).
  const onTestRedeem = async () => {
    setError(""); setRedeemResult("");
    if (!context || !delegationManager) { setError("Grant first to get a context"); return; }
    try {
      const res = await fetch(`${API_URL}/dev/test-transfer-redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chain_id: chainId,
          delegation_manager: delegationManager,
          context,
          token,
          recipient: delegate, // relayer pulls the period to itself, then bridges
          amount,
        }),
      });
      const data = await res.json();
      setRedeemResult(JSON.stringify(data, null, 2));
    } catch (e) {
      setError(friendlyError(e, "Test redeem request failed"));
    }
  };

  // Real CCTP bridge: relayer burns its own USDC on the source chain → mint on Arc.
  const onBurn = async () => {
    setBridgeErr(""); setBridgeMsg(""); setBurnTx(null);
    if (!address) { setBridgeErr("Connect a wallet first"); return; }
    try {
      const res = await fetch(`${API_URL}/dev/test-bridge-burn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain_id: chainId, token, amount, mint_recipient: address, speed: bridgeSpeed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Burn failed");
      setBurnTx({ hash: data.burn_tx_hash, domain: data.source_domain });
      setBridgeMsg(`Burned ✓ ${data.burn_tx_hash} (source domain ${data.source_domain}) — now run B.`);
    } catch (e) {
      setBridgeErr(e instanceof Error ? e.message : "Burn failed");
    }
  };

  const onReceive = async () => {
    setBridgeErr("");
    if (!burnTx) { setBridgeErr("Burn first (A)"); return; }
    try {
      const res = await fetch(`${API_URL}/dev/test-bridge-receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_domain: burnTx.domain, burn_tx_hash: burnTx.hash }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Receive failed");
      setBridgeMsg(
        data.pending
          ? "Attestation still pending — wait ~30s and click B again."
          : `Minted on Arc ✓ ${data.mint_tx_hash}`
      );
    } catch (e) {
      setBridgeErr(e instanceof Error ? e.message : "Receive failed");
    }
  };

  // Integration run: seed a DUE subscription from the granted context, run a pass, inspect.
  const onSeed = async () => {
    setIntgErr(""); setIntgMsg("");
    if (!context || !delegationManager || !address) { setIntgErr("Grant first (1) to get a context"); return; }
    try {
      const res = await fetch(`${API_URL}/dev/seed-delegated-sub`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: address,
          creator: creator || address,
          chain_id: chainId,
          delegation_manager: delegationManager,
          context,
          token,
          amount: grantedAmount || amount, // MUST match the granted period cap
          period_duration: Number(period),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Seed failed");
      setIntgMsg(`Seeded due subscription ${data.subscription_id} (amount ${grantedAmount || amount}) ✓ — now run the pass.`);
    } catch (e) {
      setIntgErr(e instanceof Error ? e.message : "Seed failed");
    }
  };

  const onRunPass = async () => {
    setIntgErr(""); setRunResult("");
    try {
      const res = await fetch(`${API_URL}/dev/run-delegated-renewals`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Run failed");
      setRunResult(JSON.stringify(data, null, 2));
    } catch (e) {
      setIntgErr(e instanceof Error ? e.message : "Run failed");
    }
  };

  const onClear = async () => {
    setIntgErr(""); setIntgMsg(""); setRunResult("");
    try {
      const res = await fetch(`${API_URL}/dev/clear-delegated-subs`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Clear failed");
      setIntgMsg(`Cleared ${data.cleared} dev subscription(s).`);
    } catch (e) {
      setIntgErr(e instanceof Error ? e.message : "Clear failed");
    }
  };

  const field = "w-full rounded border border-gray-300 px-3 py-1.5 font-mono text-xs";
  const label = "block text-xs font-medium text-gray-600 mb-0.5";

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div>
        <h1 className="text-lg font-bold">Grant-test harness <span className="text-xs font-normal text-gray-400">(dev)</span></h1>
        <p className="text-sm text-gray-500">
          Validate the C1 primitive: a 7715 periodic permission redeems as a single capped transfer
          to the relayer. Needs a 7715-capable wallet (MetaMask Flask).
        </p>
      </div>

      <ConnectButton />

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className={label}>Token (USDC on the connected chain)</label><input className={field} value={token} onChange={(e) => setToken(e.target.value)} /></div>
        <div className="col-span-2"><label className={label}>Delegate (relayer address)</label><input className={field} value={delegate} onChange={(e) => setDelegate(e.target.value)} /></div>
        <div><label className={label}>Period amount (USDC micro)</label><input className={field} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div><label className={label}>Period (seconds)</label><input className={field} value={period} onChange={(e) => setPeriod(e.target.value)} /></div>
      </div>
      <p className="text-xs text-gray-400">Connected chain id: {chainId}</p>

      <div className="mb-6 rounded border border-gray-200 p-4">
        <p className="m-0 text-sm font-semibold text-gray-900">Wallet capability probe</p>
        <p className="m-0 mt-1 text-xs text-gray-500">
          Read-only. Asks the wallet which permission and rule types it supports — nothing is signed
          and no permission is requested.
        </p>
        <button
          onClick={() => void onProbeRules()}
          disabled={!connectorClient}
          className="mt-3 rounded bg-gray-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          Probe supported rules
        </button>
        {ruleProbe && (
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded bg-gray-900 p-3 text-xs text-gray-100">
            {ruleProbe}
          </pre>
        )}
      </div>

      <button onClick={onGrant} disabled={!address} className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        1 · Grant (wallet_requestExecutionPermissions)
      </button>

      {error && <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {caveats && (
        <div>
          <p className="text-sm font-medium">Decoded caveats ({caveats.length})</p>
          <ul className="mt-1 space-y-1">
            {caveats.map((c, i) => (
              <li key={i} className="rounded bg-gray-50 px-3 py-2 font-mono text-xs">
                <div>enforcer: {c.enforcer}</div>
                <div className="truncate text-gray-500">terms: {c.terms}</div>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-gray-400">
            The first enforcer is the ERC20PeriodTransfer (period-capped transfer) — the redeem below
            executes a single transfer within that cap.
          </p>
        </div>
      )}

      {rawGrant && (
        <div>
          <p className="text-sm font-medium">Raw grant response</p>
          <pre className="mt-1 max-h-60 overflow-auto rounded bg-gray-900 p-3 text-xs text-gray-100">{rawGrant}</pre>
        </div>
      )}

      <button onClick={onTestRedeem} disabled={!context} className="rounded bg-gray-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        2 · Test redeem (simulate transfer → relayer)
      </button>

      {redeemResult && (
        <div>
          <p className="text-sm font-medium">Simulation result</p>
          <pre className="mt-1 max-h-60 overflow-auto rounded bg-gray-900 p-3 text-xs text-gray-100">{redeemResult}</pre>
          <p className="mt-1 text-xs text-gray-400">
            <code>{`{ "ok": true }`}</code> → the mandate redeems as a capped transfer (the relayer then
            bridges via CCTP to Arc). An error → read it (e.g. insufficient subscriber USDC balance).
          </p>
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <p className="text-sm font-semibold">
          Real CCTP bridge (relayer → Arc){" "}
          <span className="text-xs font-normal text-amber-700">⚠ moves real testnet funds</span>
        </p>
        <p className="text-xs text-gray-600">
          The relayer burns its OWN USDC on this source chain (amount + token above) and mints to your
          address on Arc. Requires the relayer <code className="break-all">{delegate}</code> funded with
          USDC + native gas here, and native gas on Arc.
        </p>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600">Speed</label>
          <select
            value={bridgeSpeed}
            onChange={(e) => setBridgeSpeed(e.target.value as "standard" | "fast")}
            className="rounded border border-gray-300 px-2 py-1 text-xs"
          >
            <option value="standard">standard (free, slower)</option>
            <option value="fast">fast (paid maxFee)</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={onBurn} disabled={!address} className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            A · Burn on source
          </button>
          <button onClick={onReceive} disabled={!burnTx} className="rounded bg-gray-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            B · Attest + mint on Arc
          </button>
        </div>
        {bridgeErr && <p className="text-xs text-red-600 break-all">{bridgeErr}</p>}
        {bridgeMsg && <p className="font-mono text-xs text-green-700 break-all">{bridgeMsg}</p>}
      </div>

      <div className="space-y-2 rounded-lg border border-indigo-300 bg-indigo-50 p-4">
        <p className="text-sm font-semibold">
          Integration run (seed + full pass){" "}
          <span className="text-xs font-normal text-indigo-700">⚠ executes the real redeem</span>
        </p>
        <p className="text-xs text-gray-600">
          Seeds a DUE subscription from the granted context above (at the granted amount
          {grantedAmount ? ` ${grantedAmount}` : ""}), then runs one full processDelegatedRenewals pass
          (real periodic redeem → Arc settle, or source → bridge). Grant (1) first; the subscriber
          ({address?.slice(0, 8)}…) needs USDC on the chosen chain. Changed the amount? Re-grant.
        </p>
        <div>
          <label className={label}>Creator / merchant payout (default: your address)</label>
          <input className={field} value={creator} onChange={(e) => setCreator(e.target.value)} placeholder={address ?? ""} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={onSeed} disabled={!context} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            Seed due subscription
          </button>
          <button onClick={onRunPass} className="rounded bg-gray-800 px-3 py-1.5 text-xs font-medium text-white">
            Run renewals pass
          </button>
          <button onClick={onClear} className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700">
            Clear dev subs
          </button>
        </div>
        {intgErr && <p className="text-xs text-red-600 break-all">{intgErr}</p>}
        {intgMsg && <p className="text-xs text-indigo-700 break-all">{intgMsg}</p>}
        {runResult && (
          <pre className="mt-1 max-h-72 overflow-auto rounded bg-gray-900 p-3 text-xs text-gray-100">{runResult}</pre>
        )}
      </div>
    </div>
  );
}
