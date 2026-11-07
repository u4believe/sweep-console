import { useEffect, useState } from "react";
import { isStaleBuildError, STALE_BUILD_MESSAGE, recoverFromStaleBuild } from "@/lib/chunk";
import { Kicker, Section } from "@/components/portal/primitives";
import { apiFetch, messageOf, wasCancelled } from "@/lib/stepup";
import { throwApiError } from "@/lib/errors";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface ChainBalance {
  /** Circle's code: BASE, ARB, OP, MONAD. */
  blockchain: string;
  usdcBalance: string;
  walletId: string;
  /** False when Circle could not be asked about this chain. Not the same as zero. */
  read: boolean;
}

interface BalanceData {
  /** The TOTAL across chains under direct settlement; one chain's before it. */
  usdcBalance: string;
  tokenId: string | null;
  walletId: string;
  updatedAt: string | null;
  fromCache: boolean;
  /** True when the API could not reach Circle and served the last value it had. */
  stale?: boolean;
  /** Why, in words a merchant can act on. Set only when `stale`. */
  error?: string;
  /**
   * One entry per chain the wallet is registered on. Absent on the
   * single-chain path, so every read of it has to tolerate undefined.
   */
  chains?: ChainBalance[];
  /**
   * Chains this deployment pays on that the wallet is NOT registered for.
   * USDC paid there is real and arrives — a Circle EOA has one address — but
   * Circle cannot see it, so it reads as zero. Worth saying out loud.
   */
  missingChains?: string[];
  /** Registered chains Circle could not be asked about just now. */
  unreadChains?: string[];
}

/** Human names for Circle's codes; unknown codes show as themselves. */
const CHAIN_LABEL: Record<string, string> = {
  BASE: "Base",
  ARB: "Arbitrum",
  OP: "Optimism",
  MONAD: "Monad",
  ARC: "Arc",
};
const chainLabel = (code: string) => CHAIN_LABEL[code] ?? code;

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
  /**
   * ONE outcome, not an error flag and a success flag side by side.
   *
   * They were independent, and the Circle SDK made that visible: `execute`
   * opens a modal that handles its own retries, so a wrong PIN followed by
   * the right one in the SAME modal session fires the error callback and
   * then the success callback without handleWithdraw running again. The
   * reset at the top of handleWithdraw never happened in between, so the
   * page showed "Transfer failed: …" and "Transfer submitted …" at once —
   * telling the merchant their money both did and did not move.
   *
   * Clearing each when setting the other would fix today's path and leave
   * the next one to be remembered. A single value cannot hold both.
   */
  type Outcome = { kind: "error"; message: string } | { kind: "success" } | null;
  const [outcome, setOutcome] = useState<Outcome>(null);
  /**
   * Which chain to withdraw from. "" until a balance says what exists.
   *
   * Deliberately NOT defaulted to the first chain: the destination is the
   * same address on every chain, so sending from the wrong one does not
   * bounce — it delivers real money somewhere the creator was not expecting.
   * The API refuses an ambiguous withdrawal for the same reason; this is the
   * UI half of that.
   */
  const [chain, setChain] = useState<string>("");
  /** Set while the add-chains PIN challenge is open. */
  const [addingChains, setAddingChains] = useState(false);
  /**
   * The add-chains button's OWN message, shown beside it.
   *
   * It used to report through `outcome`, which renders down beside the
   * withdraw form — far enough from this button that a failure read as
   * nothing happening at all. A button that can fail silently is a button
   * people press twice.
   */
  const [chainsNote, setChainsNote] = useState<string>("");

  /**
   * Register the wallet on the chains it is missing.
   *
   * KEEPS THE ADDRESS, which is the only reason this can be a button. A
   * Circle account has one address across EVM chains, and that address is
   * pinned into every subscriber's grant — so adding chains does not move
   * where the creator is paid and does not ask anyone to re-authorize. The
   * server verifies it did not move before storing anything.
   */
  async function handleAddChains() {
    setAddingChains(true);
    setChainsNote("");
    setOutcome(null);
    try {
      const res = await apiFetch(`/portal/wallet/circle/add-chains`, { method: "POST" });
      if (!res.ok) {
        if (await wasCancelled(res)) { setAddingChains(false); return; }
        await throwApiError(res, "Couldn't extend your wallet");
      }
      const body = await res.json() as {
        data?: { alreadyComplete?: boolean; userToken?: string; encryptionKey?: string;
                 challengeId?: string; appId?: string; adding?: string[] };
      };
      const d = body.data ?? {};
      if (d.alreadyComplete) {
        setAddingChains(false);
        setChainsNote("Already set up on every chain.");
        await loadBalance(true);
        return;
      }
      if (!d.challengeId || !d.userToken || !d.encryptionKey) {
        // Nothing to run means nothing would visibly happen, which is the
        // failure this message exists to replace.
        setAddingChains(false);
        setChainsNote("We couldn't start wallet setup. Please try again, or contact support.");
        return;
      }

      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const sdk = new W3SSdk();
      sdk.setAppSettings({ appId: import.meta.env.VITE_CIRCLE_APP_ID ?? d.appId ?? "" });
      sdk.setAuthentication({ userToken: d.userToken!, encryptionKey: d.encryptionKey! });

      sdk.execute(d.challengeId!, async (err) => {
        if (err) {
          setAddingChains(false);
          setChainsNote(`Couldn't add chains: ${err.message ?? "the PIN step was cancelled"}`);
          return;
        }
        // Circle has accepted the PIN; the server now checks the address did
        // not move before it trusts the result.
        try {
          const res2 = await apiFetch(`/portal/wallet/circle/confirm-chains`, { method: "POST" });
          if (!res2.ok) await throwApiError(res2, "Couldn't confirm the new chains");
          const done = (await res2.json()) as { data?: { chains?: Array<{ blockchain: string }> } };
          await loadBalance(true);
          /**
           * Say what the server actually reported, not what was hoped for.
           *
           * This said "Done — your wallet now covers every chain" whenever
           * the call returned ok, and the server returned ok for an EMPTY
           * result — so a creator whose wallet was never created was told it
           * had been, with the "not set up for…" notice still on screen
           * underneath. The server now refuses an empty result, and this
           * counts what came back rather than assuming.
           */
          const got = (done?.data?.chains ?? []) as Array<{ blockchain: string }>;
          setChainsNote(
            got.length > 0
              ? `Done — now on ${got.map((c) => chainLabel(c.blockchain)).join(", ")}.`
              : "Circle reported no new chains. Nothing has changed."
          );
        } catch (e) {
          setChainsNote(e instanceof Error ? e.message : "Couldn't confirm the new chains");
        } finally {
          setAddingChains(false);
        }
      });
    } catch (e) {
      setAddingChains(false);
      setChainsNote(e instanceof Error ? e.message : "Couldn't extend your wallet");
    }
  }

  function loadBalance(force = false) {
    const url = `${API_URL}/portal/wallet/circle/balance${force ? "?refresh=1" : ""}`;
    return fetch(url, { credentials: "include" })
      .then((r) => r.json())
      .then((json: { data?: BalanceData; error?: { message?: string } }) => {
        if (json.data) {
          setBalance(json.data);
          // Pre-select only when there is nothing to choose between: one
          // funded chain, and every chain read cleanly.
          const funded = (json.data.chains ?? []).filter(
            (c) => c.read && parseFloat(c.usdcBalance) > 0
          );
          const anyUnread = (json.data.chains ?? []).some((c) => !c.read);
          setChain((prev) =>
            prev && funded.some((c) => c.blockchain === prev)
              ? prev
              : funded.length === 1 && !anyUnread
                ? funded[0]!.blockchain
                : ""
          );
        }
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
    setOutcome(null);

    try {
      // The highest-stakes button in the portal: it moves real USDC out. Once
      // an authenticator is enrolled this accepts nothing else — see the mixed
      // policy in the API's lib/portal/stepup.ts.
      const res = await apiFetch(`/portal/wallet/circle/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send the chain only when the server offered chains at all, so the
        // single-chain deployment keeps its exact request shape.
        body: JSON.stringify({
          destinationAddress: dest,
          amount,
          ...(balance?.chains?.length && chain ? { blockchain: chain } : {}),
        }),
      });
      if (!res.ok) {
        if (await wasCancelled(res)) { setWithdrawing(false); return; }
        await throwApiError(res, "Withdrawal failed");
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
        if (err) {
          setOutcome({ kind: "error", message: `Transfer failed: ${err.message ?? "Unknown error"}` });
          return;
        }
        setOutcome({ kind: "success" });
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
      if (isStaleBuildError(e)) {
        // Recovers by itself where it can; the message is for when it cannot.
        if (recoverFromStaleBuild()) return;
        setOutcome({ kind: "error", message: STALE_BUILD_MESSAGE });
      } else {
        setOutcome({ kind: "error", message: e instanceof Error ? e.message : "Something went wrong" });
      }
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
                fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 34,
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
          {/* A number the API could not refresh is not the same as a number it
              refreshed to zero. Without this the page said "cached" and left
              the merchant to guess, which is exactly how a wallet holding 150
              USDC read as empty for a day. */}
          {balance?.stale && (
            <p
              className="m-0 mt-1"
              style={{ fontSize: 11.5, color: "var(--color-accent-700)", maxWidth: 320 }}
            >
              {balance.error ?? "We couldn't refresh this just now."}
            </p>
          )}

          {/* Where the money actually is. A single total hides that 52.75 USDC
              is two withdrawals on two chains, which is what the creator has
              to act on. Only rendered when the API sent a breakdown. */}
          {(balance?.chains?.length ?? 0) > 1 && (
            <div className="m-0 mt-3" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {balance!.chains!.map((c) => (
                <span
                  key={c.blockchain}
                  style={{
                    fontSize: 11.5,
                    padding: "3px 8px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-neutral-300)",
                    color: c.read ? "var(--color-neutral-800)" : "var(--color-neutral-600)",
                  }}
                >
                  {chainLabel(c.blockchain)}{" "}
                  <strong style={{ fontWeight: 600 }}>
                    {c.read ? parseFloat(c.usdcBalance).toFixed(2) : "—"}
                  </strong>
                </span>
              ))}
            </div>
          )}

          {/* Registered nowhere is the failure that reads as an empty wallet
              over money that is there: a Circle EOA has one address, so USDC
              arrives whatever Circle knows about. Say so rather than show a
              zero. */}
          {(balance?.missingChains?.length ?? 0) > 0 && (
            <p
              className="m-0 mt-2"
              style={{ fontSize: 11.5, color: "var(--color-accent-700)", maxWidth: 340 }}
            >
              Your wallet isn't set up for{" "}
              {balance!.missingChains!.map(chainLabel).join(", ")} yet. USDC paid to you there is
              safe, but won't show here until you add them.
              <br />
              <button
                type="button"
                onClick={() => void handleAddChains()}
                disabled={addingChains}
                style={{
                  marginTop: 8,
                  font: "inherit",
                  fontSize: 11.5,
                  fontWeight: 600,
                  padding: "5px 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-accent)",
                  background: "transparent",
                  color: "var(--color-accent)",
                  cursor: addingChains ? "not-allowed" : "pointer",
                }}
              >
                {addingChains
                  ? "Adding…"
                  : `Add ${balance!.missingChains!.map(chainLabel).join(" & ")}`}
              </button>
              {/* Said out loud because the alternative — a creator fearing a
                  new payout address — is the reason they would not click. */}
              <span style={{ display: "block", marginTop: 6, color: "var(--color-neutral-600)" }}>
                Your payout address doesn't change, and your subscribers don't need to do anything.
              </span>
              {chainsNote && (
                <span style={{ display: "block", marginTop: 6, fontWeight: 600 }}>{chainsNote}</span>
              )}
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

      {outcome?.kind === "success" && (
        <p className="tag tag-outline mb-4" style={{ padding: "8px 12px" }}>
          Transfer submitted — it may take a few minutes to confirm on-chain.
        </p>
      )}
      {outcome?.kind === "error" && (
        <p className="m-0 mb-4" style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{outcome.message}</p>
      )}

      <form onSubmit={handleWithdraw} className="max-w-lg space-y-3">
        {/* FIRST, because it decides what the amount means.
            Only shown when there is a choice — a single-chain wallet has
            nothing to pick and should not be asked. "Select…" stays selected
            until the creator chooses, so a mis-send needs a decision rather
            than a missed glance. */}
        {(balance?.chains?.length ?? 0) > 1 && (
          <div className="field">
            <label htmlFor="wd-chain">Withdraw from</label>
            <select
              id="wd-chain"
              className="input"
              value={chain}
              onChange={(e) => setChain(e.target.value)}
              required
            >
              <option value="">Select a chain…</option>
              {balance!.chains!.map((c) => (
                <option
                  key={c.blockchain}
                  value={c.blockchain}
                  disabled={!c.read || parseFloat(c.usdcBalance) <= 0}
                >
                  {chainLabel(c.blockchain)} —{" "}
                  {c.read ? `${parseFloat(c.usdcBalance).toFixed(2)} USDC` : "couldn't read"}
                </option>
              ))}
            </select>
            {chain && (
              <p className="m-0 mt-1" style={{ fontSize: 11.5, color: "var(--color-neutral-600)" }}>
                Sending on {chainLabel(chain)}. The address above must be able to receive USDC
                there.
              </p>
            )}
          </div>
        )}
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
          /**
           * The TOTAL being non-zero is not enough once there are chains: a
           * creator with money on Base and nothing selected would submit a
           * withdrawal the API then refuses. Block it here instead, so the
           * button's state matches what the server will accept.
           */
          disabled={
            withdrawing ||
            !balance ||
            parseFloat(balance.usdcBalance) === 0 ||
            ((balance.chains?.length ?? 0) > 1 && !chain)
          }
        >
          {withdrawing ? "Awaiting confirmation…" : "Withdraw"}
        </button>
      </form>
    </Section>
  );
}
