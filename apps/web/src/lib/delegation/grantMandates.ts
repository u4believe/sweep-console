// Shared cross-chain grant loop.
//
// Grants one ERC-7715 renewal mandate per funded source chain and hands each
// result to a `save` callback. Used by the checkout toggle (DelegatedRenewalToggle
// → saveDelegation, session-bound), the "Pay from other chains" panel
// (GatewaySweepPanel), and the standalone /manage portal (subscription-bound save)
// so the granting logic lives in one place.
//
// Each target is a DIFFERENT chain, and wallet_requestExecutionPermissions needs
// the wallet's active chain to match the one in the request — so we switch chains
// and fetch a fresh connector client before every grant. A client captured once
// (e.g. via useConnectorClient() at render time) goes stale the moment the wallet
// switches chains underneath it, which surfaced as a generic "Request cancelled"
// on the 2nd+ chain (see diagnostics.ts).
//
// Each target chain also needs its own EIP-7702 smart-account upgrade before
// MetaMask will grant a permission there (see upgrade.ts) — upgrade state is
// per-chain account code, so a chain upgraded earlier in the loop doesn't cover
// the next one.

import { type Address } from "viem";
import { getChainId, getConnectorClient, switchChain } from "wagmi/actions";
import { grantRenewalMandate } from "./grant";
import { ensureSmartAccount } from "./upgrade";
import { wagmiConfig } from "@/lib/wagmi";
import type { GrantTarget } from "@/lib/gateway";
import {
  isRequestSuperseded,
  logGrantAttempt,
  logGrantFailure,
  logGrantSuccess,
  readActiveChainId,
} from "./diagnostics";

const MANDATE_LIFETIME_SEC = 31_536_000; // 1 year
const CHAIN_SWITCH_POLL_MS = 150;
const CHAIN_SWITCH_POLL_ATTEMPTS = 40; // ~6s worst case

// wagmi/actions types switchChain/getConnectorClient against the config's own
// chain-id literal union — targets come from the API as a plain `number`, so we
// widen at this one boundary rather than threading the literal type everywhere.
type ConfiguredChainId = (typeof wagmiConfig)["chains"][number]["id"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MISMATCH_RETRY_ATTEMPTS = 6;
const MISMATCH_RETRY_SLEEP_MS = 250;

/// Switch the wallet to `chainId` and wait for it to actually report the switch
/// before handing back a connector client — mirrors the same wait used before
/// signing the Arc permit, since wallets don't always resolve switchChain
/// synchronously with the RPC actually completing.
///
/// getConnectorClient() re-checks the connector's OWN live chain (a fresh
/// connector.getChainId() call) against the requested one and throws
/// ConnectorChainMismatchError if they disagree — which can still happen right
/// after the poll above already saw wagmi's store agree, because the store and
/// the connector's own cached chain settle at slightly different times. Retry
/// through that exactly like signOnChain() already does for signTypedData.
async function connectorClientOnChain(chainId: number) {
  const target = chainId as ConfiguredChainId;
  if (getChainId(wagmiConfig) !== chainId) {
    await switchChain(wagmiConfig, { chainId: target });
    for (let i = 0; i < CHAIN_SWITCH_POLL_ATTEMPTS && getChainId(wagmiConfig) !== chainId; i++) {
      await sleep(CHAIN_SWITCH_POLL_MS);
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await getConnectorClient(wagmiConfig, { chainId: target });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < MISMATCH_RETRY_ATTEMPTS && /does not match the connection|ConnectorChainMismatch/.test(msg)) {
        await switchChain(wagmiConfig, { chainId: target }).catch(() => {});
        await sleep(MISMATCH_RETRY_SLEEP_MS);
        continue;
      }
      throw e;
    }
  }
}

export interface GrantFailure {
  target: GrantTarget;
  error: unknown;
}

/// Grant a mandate per target, persisting each via `save` (the API's grant/
/// delegation endpoint — session-bound at checkout, subscription-bound in the
/// portal). Calls `onProgress` after every successful grant so callers can render
/// an "Authorizing N/M…" state.
///
/// A single target's failure does NOT abort the remaining targets — every
/// supported chain is offered independently, so one rejection or transient
/// wallet error shouldn't cost the subscriber the chains that would have
/// worked. Returns the targets that failed (empty when all succeeded); throws
/// only when EVERY target failed, since callers treat a thrown error as
/// "nothing was enabled" (see DelegatedRenewalToggle / GatewaySweepPanel).
export async function grantRenewalMandates(
  walletAddress: string,
  targets: GrantTarget[],
  save: (input: Record<string, unknown>) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void
): Promise<GrantFailure[]> {
  const now = Math.floor(Date.now() / 1000);
  const request = (client: Awaited<ReturnType<typeof connectorClientOnChain>>, t: GrantTarget) =>
    grantRenewalMandate(client, {
      chainId: t.chain_id,
      token: t.token,
      delegate: t.delegate,
      periodAmountMicro: BigInt(t.period_amount),
      periodDurationSec: t.period_duration,
      startTimeSec: now,
      expirySec: now + MANDATE_LIFETIME_SEC,
      justification: `Cross-chain renewals on ${t.name} when your Arc balance is low — capped to one period each cycle, revocable anytime.`,
    });

  let done = 0;
  const failures: GrantFailure[] = [];
  for (const t of targets) {
    const ctx = { index: done + failures.length + 1, total: targets.length, targetChainId: t.chain_id, chainName: t.name };
    try {
      const client = await connectorClientOnChain(t.chain_id);

      // MetaMask will only grant an ERC-7715 permission from a smart account —
      // upgrade this chain first (EIP-7702) if it isn't one there yet. No-op if
      // already upgraded on this specific chain.
      await ensureSmartAccount(client, walletAddress as Address, t.chain_id);

      logGrantAttempt(ctx, await readActiveChainId(client));

      let mandate;
      try {
        mandate = await request(client, t);
      } catch (e) {
        logGrantFailure(ctx, e, await readActiveChainId(client));
        // A superseded (-32002) request means the wallet killed ours, not the
        // user rejecting it — retry once now that the chain switch has settled.
        if (!isRequestSuperseded(e)) throw e;
        mandate = await request(await connectorClientOnChain(t.chain_id), t);
      }
      logGrantSuccess(ctx, await readActiveChainId(client));

      await save({
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
      onProgress?.(++done, targets.length);
    } catch (e) {
      failures.push({ target: t, error: e });
    }
  }

  if (failures.length > 0 && failures.length === targets.length) throw failures[0]!.error;
  return failures;
}
