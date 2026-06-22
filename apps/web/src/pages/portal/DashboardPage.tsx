import { useEffect, useState } from "react";
import { WalletSetupBanner } from "@/components/portal/WalletSetupBanner";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface DashboardData {
  activeSubs: number;
  totalRevenue: number;
  plans: number;
  failedPayments: number;
  walletAddress: string | null;
  walletType: string;
}

interface BalanceData {
  usdcBalance: string;
  tokenId: string | null;
  walletId: string;
  updatedAt: string | null;
  fromCache: boolean;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="ml-2 rounded px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 transition"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function WithdrawSection({ walletId }: { walletId: string }) {
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [balanceErr, setBalanceErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [dest, setDest] = useState("");
  const [amount, setAmount] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawErr, setWithdrawErr] = useState("");
  const [withdrawSuccess, setWithdrawSuccess] = useState(false);

  function loadBalance(force = false) {
    const url = `${API_URL}/portal/wallet/circle/balance${force ? "?refresh=1" : ""}`;
    return fetch(url, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: BalanceData; error?: { message?: string } }) => {
        if (json.data) setBalance(json.data);
        else setBalanceErr(json.error?.message ?? "Failed to fetch balance");
      })
      .catch(() => setBalanceErr("Could not reach the API server"));
  }

  useEffect(() => { void loadBalance(); }, [walletId]);

  async function handleRefresh() {
    setRefreshing(true);
    setBalanceErr("");
    await loadBalance(true);
    setRefreshing(false);
  }

  async function handleWithdraw(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setWithdrawing(true);
    setWithdrawErr("");

    try {
      const res = await fetch(`${API_URL}/portal/wallet/circle/withdraw`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinationAddress: dest, amount }),
      });
      const data = await res.json() as {
        userToken?: string; encryptionKey?: string; challengeId?: string; appId?: string;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(data.error?.message ?? "Withdrawal failed");

      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const sdk = new W3SSdk();
      const effectiveAppId = import.meta.env.VITE_CIRCLE_APP_ID ?? data.appId ?? "";
      sdk.setAppSettings({ appId: effectiveAppId });
      sdk.setAuthentication({ userToken: data.userToken!, encryptionKey: data.encryptionKey! });

      sdk.execute(data.challengeId!, (err) => {
        setWithdrawing(false);
        if (err) { setWithdrawErr(`Transfer failed: ${err.message ?? "Unknown error"}`); return; }
        setWithdrawSuccess(true);
        setDest("");
        setAmount("");
        // Refresh balance after a short delay
        setTimeout(() => {
          fetch(`${API_URL}/portal/wallet/circle/balance`, { credentials: "include" })
            .then((r) => r.json())
            .then((json: { data?: BalanceData }) => { if (json.data) setBalance(json.data); });
        }, 3000);
      });
    } catch (e) {
      setWithdrawing(false);
      setWithdrawErr(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  return (
    <div className="mt-8 bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="mb-1 text-lg font-semibold text-gray-900">Withdraw Revenue</h2>
      <p className="mb-5 text-sm text-gray-500">
        Transfer USDC from your Circle wallet to any EVM address.
      </p>

      <div className="mb-5 flex items-center gap-4 flex-wrap">
        <div className="rounded-lg bg-green-50 border border-green-100 px-5 py-3">
          <p className="text-xs text-gray-500 mb-0.5">Available balance</p>
          {balanceErr ? (
            <p className="text-sm text-red-600">{balanceErr}</p>
          ) : balance === null ? (
            <div className="h-6 w-24 rounded bg-gray-200 animate-pulse" />
          ) : (
            <p className="text-2xl font-bold text-green-700">
              {parseFloat(balance.usdcBalance).toFixed(2)}{" "}
              <span className="text-base font-medium">USDC</span>
            </p>
          )}
          {balance?.updatedAt && (
            <p className="mt-1 text-xs text-gray-400">
              Updated {timeAgo(balance.updatedAt)}
              {balance.fromCache && " · cached"}
            </p>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing || balance === null}
          className="self-start mt-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {withdrawSuccess && (
        <div className="mb-4 rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 font-medium">
          Transfer submitted — it may take a few minutes to confirm on-chain.
        </div>
      )}

      {withdrawErr && (
        <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{withdrawErr}</p>
      )}

      <form onSubmit={handleWithdraw} className="space-y-4 max-w-lg">
        <div>
          <label className="block mb-1.5 text-sm font-medium text-gray-700">Destination address</label>
          <input
            type="text"
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            placeholder="0x..."
            required
            pattern="^0x[a-fA-F0-9]{40}$"
            title="Must be a 0x-prefixed EVM address (42 characters)"
            className="w-full rounded-lg border border-gray-200 px-4 py-2.5 font-mono text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block mb-1.5 text-sm font-medium text-gray-700">Amount (USDC)</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="10.00"
            required
            min="0.01"
            step="0.01"
            className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <button
          type="submit"
          disabled={withdrawing || !balance || parseFloat(balance.usdcBalance) === 0}
          className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {withdrawing ? "Awaiting confirmation…" : "Withdraw"}
        </button>
      </form>
    </div>
  );
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/portal/dashboard`, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: DashboardData; error?: { message?: string } }) => {
        if (json.data) setData(json.data);
        else setError(json.error?.message ?? "Failed to load dashboard");
      })
      .catch(() => setError("Could not reach the API server"));
  }, []);

  if (error) return <div className="rounded-xl bg-red-50 p-6 text-sm text-red-600">{error}</div>;

  const cards = data
    ? [
        { label: "Active Subscriptions", value: data.activeSubs, color: "text-blue-700" },
        { label: "Total Revenue (USDC)", value: `$${(data.totalRevenue / 1_000_000).toFixed(2)}`, color: "text-green-700" },
        { label: "Active Plans", value: data.plans, color: "text-purple-700" },
        { label: "Failed Payments", value: data.failedPayments, color: "text-red-700" },
      ]
    : [];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Dashboard</h1>

      {data && !data.walletAddress && (
        <WalletSetupBanner hasCircleWallet={data.walletType === "circle"} />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {data
          ? cards.map((card) => (
              <div key={card.label} className="bg-white rounded-xl border border-gray-200 p-6">
                <p className="text-sm font-medium text-gray-500">{card.label}</p>
                <p className={`mt-2 text-3xl font-bold ${card.color}`}>{card.value}</p>
              </div>
            ))
          : Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 p-6 animate-pulse">
                <div className="h-3 w-24 rounded bg-gray-200" />
                <div className="mt-3 h-8 w-16 rounded bg-gray-200" />
              </div>
            ))}
      </div>

      {/* Linked wallet card */}
      {data?.walletAddress && (
        <div className="mt-6 bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-sm font-medium text-gray-500 mb-1">Linked Payout Wallet</p>
              <div className="flex items-center">
                <span className="font-mono text-sm text-gray-900 break-all">{data.walletAddress}</span>
                <CopyButton text={data.walletAddress} />
              </div>
            </div>
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${data.walletType === "circle" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>
              {data.walletType === "circle" ? "Circle Wallet" : "External Wallet"}
            </span>
          </div>
        </div>
      )}

      {/* Withdraw section — Circle wallets only */}
      {data?.walletAddress && data.walletType === "circle" && (
        <WithdrawSection walletId={data.walletAddress} />
      )}

      <div className="mt-8 bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="mb-1 text-lg font-semibold text-gray-900">Quick Start</h2>
        <p className="mb-4 text-sm text-gray-500">Integrate SweepConsole into your app in two steps:</p>
        <ol className="space-y-3 text-sm text-gray-700">
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">1</span>
            <span>Create a plan, then call <code className="rounded bg-gray-100 px-1 font-mono text-xs">POST /v1/checkout/sessions</code> with your <code className="rounded bg-gray-100 px-1 font-mono text-xs">plan_id</code> from your server.</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">2</span>
            <span>Register a webhook endpoint to receive <code className="rounded bg-gray-100 px-1 font-mono text-xs">subscription.created</code> and upgrade the user in your database.</span>
          </li>
        </ol>
      </div>
    </div>
  );
}
