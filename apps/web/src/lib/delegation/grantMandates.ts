// Shared cross-chain grant loop.
//
// Grants one ERC-7715 renewal mandate per funded source chain and hands each
// result to a `save` callback. Used by BOTH the checkout toggle
// (DelegatedRenewalToggle → saveDelegation, session-bound) and the standalone
// /manage portal (subscription-bound save) so the granting logic lives in one place.

import { type Client } from "viem";
import { grantRenewalMandate } from "./grant";
import type { GrantTarget } from "@/lib/gateway";

const MANDATE_LIFETIME_SEC = 31_536_000; // 1 year

/// Grant a mandate per target, persisting each via `save` (the API's grant/
/// delegation endpoint — session-bound at checkout, subscription-bound in the
/// portal). Calls `onProgress` after every successful grant so callers can render
/// an "Authorizing N/M…" state.
export async function grantRenewalMandates(
  connectorClient: Client,
  walletAddress: string,
  targets: GrantTarget[],
  save: (input: Record<string, unknown>) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let done = 0;
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
  }
}
