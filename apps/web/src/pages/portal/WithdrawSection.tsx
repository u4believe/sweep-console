import { useEffect, useState } from "react";
import { Kicker, Section } from "@/components/portal/primitives";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface BalanceData {
  usdcBalance: string;
  tokenId: string | null;
  walletId: string;
  updatedAt: string | null;
  fromCache: boolean;
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

/**
 * Withdrawals out of a Circle programmable wallet. Only rendered for merchants
 * whose payout wallet is Circle-held — an external wallet is theirs to move
 * from directly.
 */
export function WithdrawSection({ walletId }: { walletId: string }) {
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
      // The highest-stakes button in the portal: it moves real USDC out. Once
      // an authenticator is enrolled this accepts nothing else — see the mixed
      // policy in the API's lib/portal/stepup.ts.
      const res = await apiFetch(`/portal/wallet/circle/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinationAddress: dest, amount }),
      });
      if (!res.ok) {
        if (await wasCancelled(res)) { setWithdrawing(false); return; }
        throw new Error(await messageOf(res, "Withdrawal failed"));
      }
      const data = await res.json() as {
        userToken?: string; encryptionKey?: string; challengeId?: string; appId?: string;
      };

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
    <Section title="Withdraw revenue">
      <p className="m-0 mb-5" style={{ fontSize: 13, color: "var(--color-neutral-700)" }}>
        Transfer USDC from your Circle wallet to any EVM address.
      </p>

      <div
        className="mb-5 flex flex-wrap items-start gap-4"
        style={{ borderTop: "1px solid var(--color-divider)", paddingTop: 14 }}
      >
        <div>
          <Kicker>Available balance</Kicker>
          {balanceErr ? (
            <p className="m-0" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{balanceErr}</p>
          ) : balance === null ? (
            <div className="h-8 w-32 animate-pulse" style={{ background: "var(--color-neutral-300)" }} />
          ) : (
            <p
              className="m-0"
              style={{
                fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 34,
                lineHeight: 1, letterSpacing: "-0.03em",
              }}
            >
              {parseFloat(balance.usdcBalance).toFixed(2)}{" "}
              <span style={{ fontSize: 15 }}>USDC</span>
            </p>
          )}
          {balance?.updatedAt && (
            <p className="m-0 mt-2" style={{ fontSize: 11.5, color: "var(--color-neutral-600)" }}>
              Updated {timeAgo(balance.updatedAt)}{balance.fromCache && " · cached"}
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ padding: "7px 12px", fontSize: 12 }}
          onClick={handleRefresh}
          disabled={refreshing || balance === null}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {withdrawSuccess && (
        <p className="tag tag-outline mb-4" style={{ padding: "8px 12px" }}>
          Transfer submitted — it may take a few minutes to confirm on-chain.
        </p>
      )}
      {withdrawErr && (
        <p className="m-0 mb-4" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{withdrawErr}</p>
      )}

      <form onSubmit={handleWithdraw} className="max-w-lg space-y-3">
        <div className="field">
          <label htmlFor="wd-dest">Destination address</label>
          <input
            id="wd-dest"
            className="input"
            type="text"
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            placeholder="0x…"
            required
            pattern="^0x[a-fA-F0-9]{40}$"
            title="Must be a 0x-prefixed EVM address (42 characters)"
            style={{ fontFamily: "ui-monospace, Menlo, monospace" }}
          />
        </div>
        <div className="field">
          <label htmlFor="wd-amount">Amount (USDC)</label>
          <input
            id="wd-amount"
            className="input"
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="10.00"
            required
            min="0.01"
            step="0.01"
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={withdrawing || !balance || parseFloat(balance.usdcBalance) === 0}
        >
          {withdrawing ? "Awaiting confirmation…" : "Withdraw"}
        </button>
      </form>
    </Section>
  );
}
