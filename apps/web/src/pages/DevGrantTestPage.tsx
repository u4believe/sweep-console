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

import { useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useConnectorClient } from "wagmi";
import { decodeAbiParameters, type Hex } from "viem";
import { grantRenewalMandate } from "@/lib/delegation/grant";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const DEFAULT_DELEGATE = (import.meta.env.VITE_RENEWAL_DELEGATE_ADDRESS as string) ?? "";
// Base Sepolia USDC by default — change to match your connected chain.
const DEFAULT_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

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
  const [delegate, setDelegate] = useState(DEFAULT_DELEGATE);
  const [amount, setAmount] = useState("1000000"); // 1 USDC
  const [period, setPeriod] = useState("2592000"); // 30 days

  const [rawGrant, setRawGrant] = useState("");
  const [caveats, setCaveats] = useState<{ enforcer: string; terms: string }[] | null>(null);
  const [context, setContext] = useState<Hex | null>(null);
  const [delegationManager, setDelegationManager] = useState<string | null>(null);
  const [redeemResult, setRedeemResult] = useState("");
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

  const onGrant = async () => {
    setError(""); setRawGrant(""); setCaveats(null); setContext(null); setRedeemResult("");
    if (!address || !connectorClient) { setError("Connect a wallet first"); return; }
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
      setError(e instanceof Error ? e.message : "Grant failed (need MetaMask Flask?)");
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
      setError(e instanceof Error ? e.message : "Test redeem request failed");
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
