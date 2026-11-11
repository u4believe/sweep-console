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
/// Seconds → the word a sentence needs. The prompt is read by a person deciding
/// whether to trust it, so "per day" beats "per 86400 seconds".
function intervalNoun(seconds: number): string {
  if (seconds <= 86_400) return "day";
  if (seconds <= 604_800) return "week";
  if (seconds <= 2_678_400) return "month";
  return "year";
}

/**
 * What the wallet shows the subscriber when it asks them to sign.
 *
 * This is the only sentence standing between a standing payment authorization
 * and someone clicking approve, so it names both parties: the merchant they
 * think they are paying, and Sweep Console, which is the delegate actually
 * permitted to move the money. It used to say renewals would run "when your Arc
 * balance is low", which described a funding path that no longer exists — Arc
 * settles payments and is never pulled from — and named neither party.
 *
 * "Up to" rather than a bare amount, because the permission authorises a
 * MAXIMUM and not a commitment: a rail developer may charge less than the cap,
 * or nothing at all in a given period, and "pay 5.00 USDC per day" would read
 * as a promise to take exactly that.
 *
 * And deliberately not "one charge per period", which is the phrasing anyone
 * will reach for next. That is true of a hosted subscription, where claimPeriod
 * holds (subscriptionId, periodKey) under a unique constraint so exactly one
 * charge can land — and false on the external rail, where a developer may
 * collect several times inside one period so long as they sum to the cap.
 * Promising a protection only half the product provides is the one mistake this
 * sentence must not make. The cap is what the enforcer and the period ledger
 * actually bound, whichever model is charging.
 *
 * "Subscription" is gone for the same reason: on the rail the charges may be
 * usage, invoices or credits, and a mandate carries no plan to check against.
 */
function justificationFor(t: GrantTarget, merchantName: string | undefined): string {
  const amount = (Number(t.period_amount) / 1_000_000).toFixed(2);
  const per = intervalNoun(t.period_duration);
  const who = merchantName ?? "This merchant";
  return (
    `${who}: pay up to ${amount} USDC per ${per} on ${t.name}, collected by Sweep Console. ` +
    `Revocable anytime in your wallet.`
  );
}

/**
 * The implementation an EOA is 7702-delegated to, or null.
 *
 * Read through the connector client rather than a separate transport, so it
 * uses the same RPC the wallet is already talking to and needs no extra
 * configuration. Never throws: a diagnostic that can fail a grant is worse
 * than a diagnostic.
 */
async function readDelegationTarget(
  client: Awaited<ReturnType<typeof connectorClientOnChain>> | undefined,
  account: Address
): Promise<string | null> {
  if (!client) return null;
  try {
    const code = (await client.request({
      method: "eth_getCode",
      params: [account, "latest"],
    } as never)) as string | null;
    if (!code || code === "0x") return "none (plain EOA)";
    if (!code.toLowerCase().startsWith("0xef0100")) return `contract, not a 7702 delegation`;
    return `0x${code.slice(8, 48)}`;
  } catch {
    return null;
  }
}

export async function grantRenewalMandates(
  walletAddress: string,
  targets: GrantTarget[],
  save: (input: Record<string, unknown>) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void,
  /// Named in the prompt. Optional so a caller without one still signs, with
  /// wording that is vaguer but never wrong.
  merchantName?: string,
  /**
   * Where a failure goes to be seen. Optional, and never awaited for its
   * result — the caller supplies the session and API base it alone knows, and
   * a report that fails must not fail a grant.
   */
  report?: (info: {
    stage: "probe" | "upgrade" | "request" | "save";
    attempt: string;
    targetChainId: number;
    targetChainName?: string;
    activeChainId: number | null;
    requestShape: {
      chain_id: number;
      to: string;
      expiry?: number;
      payee_count: number;
      permission_type: string;
      sends_redeemer: boolean;
      delegated_to: string | null;
    };
    error: unknown;
  }) => void,
  /**
   * Fired as each chain is ATTEMPTED, so a caller can say which one the
   * wallet is being asked about. Distinct from onProgress, which counts the
   * ones that landed — last in the list so the existing call sites, which
   * stop at `report`, keep compiling unchanged.
   */
  onAttempt?: (index: number, total: number) => void
): Promise<GrantFailure[]> {
  const now = Math.floor(Date.now() / 1000);
  const request = (client: Awaited<ReturnType<typeof connectorClientOnChain>>, t: GrantTarget) =>
    grantRenewalMandate(client, {
      chainId: t.chain_id,
      token: t.token,
      delegate: t.delegate,
      /**
       * The departures from the documented request, each decided by the API.
       *
       * Undefined means "send the documented shape", which is what every
       * deployment does unless it opts out. PeriodicErc20MandateInput says
       * why each one exists and why it is off.
       */
      payees: t.payees,
      periodAmountMicro: BigInt(t.period_amount),
      periodDurationSec: t.period_duration,
      // Omitted unless asked for: the guide does not send it.
      startTimeSec: t.send_start_time ? now : undefined,
      allowAdjustment: t.allow_adjustment,
      pinRedeemer: t.pin_redeemer,
      /**
       * What the GRANT says, when the grant says anything.
       *
       * This was always now + MANDATE_LIFETIME_SEC, so the rail's authorize
       * page displayed the mandate's expires_at while asking the wallet for a
       * year — two different dates, one of them shown to the payer and the
       * other one actually signed.
       *
       * The fallback stays for the hosted paths, which send no expiry because
       * a subscription has no fixed end.
       */
      expirySec: t.expiry_sec ?? now + MANDATE_LIFETIME_SEC,
      justification: justificationFor(t, merchantName),
    });

  let done = 0;
  const failures: GrantFailure[] = [];
  for (const t of targets) {
    const ctx = { index: done + failures.length + 1, total: targets.length, targetChainId: t.chain_id, chainName: t.name };
    /**
     * Which call failed, not merely that one did.
     *
     * The four awaits below fail identically from the outside — a rejected
     * promise reaching one catch — and they mean entirely different things: a
     * chain switch refused, a 7702 upgrade refused, the permission itself
     * refused, or our own save failing after the subscriber already signed.
     * EIP-1193 4100 is reachable from the middle two, and guessing which cost
     * this migration three wrong diagnoses.
     */
    /**
     * Say which chain is being signed BEFORE asking for it.
     *
     * onProgress only ran after save() succeeded, so the counter reported
     * chains COMPLETED while the label read "Signing N of M — approve each in
     * your wallet", which is a claim about the chain in hand. With every
     * permission refused it sat at "1 of 4" through all four prompts, looking
     * like a stuck UI rather than four failures. It was telling the truth
     * about completions and lying about what it said it was describing.
     *
     * Reporting the attempt here makes the label mean what it says; the
     * completion count still advances only on a real save below.
     */
    /**
     * ONE-BASED, AND THE ONLY THING THAT DRIVES "Signing N of M".
     *
     * This passed `done + failures.length` into the same state onProgress
     * writes `done` to, and the label rendered `done + 1`. Two writers, two
     * meanings — chains ATTEMPTED and chains COMPLETED — in one number.
     *
     * The visible symptom was a count that skipped: two chains failing
     * without a wallet prompt advanced `failures` twice between renders, so
     * the label went 2 of 4 straight to 4 of 4. It could also go backwards,
     * since a success incremented `done` while ignoring earlier failures.
     *
     * The label is a claim about the chain in hand, so the index of the chain
     * in hand is what it gets, and nothing else writes to it.
     */
    onAttempt?.(ctx.index, targets.length);
    let stage: "probe" | "upgrade" | "request" | "save" = "probe";
    let client: Awaited<ReturnType<typeof connectorClientOnChain>> | undefined;
    try {
      client = await connectorClientOnChain(t.chain_id);

      // MetaMask will only grant an ERC-7715 permission from a smart account —
      // upgrade this chain first (EIP-7702) if it isn't one there yet. No-op if
      // already upgraded on this specific chain.
      stage = "upgrade";
      await ensureSmartAccount(client, walletAddress as Address, t.chain_id);

      logGrantAttempt(ctx, await readActiveChainId(client));

      stage = "request";
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

      stage = "save";
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
      report?.({
        stage,
        /**
         * WHICH ATTEMPT THIS WAS, because the count decides how to read it.
         *
         * grantRenewalMandates only throws when EVERY target fails, so one
         * failure in a log is ambiguous: four chains all refused, or three
         * already granted and the fourth refused. Those have different
         * causes and different fixes, and a single [grant-failure] line
         * could not be told apart.
         */
        attempt: `${ctx.index} of ${ctx.total}`,
        targetChainId: t.chain_id,
        targetChainName: t.name,
        activeChainId: client ? await readActiveChainId(client).catch(() => null) : null,
        requestShape: {
          chain_id: t.chain_id,
          to: t.delegate,
          expiry: t.expiry_sec,
          payee_count: t.payees?.length ?? 0,
          permission_type: "erc20-token-periodic",
          sends_redeemer: true,
          /**
           * WHAT THE PAYER'S ACCOUNT IS DELEGATED TO on this chain, which is
           * the fact that explained a month of 4100s and -32603s in one line.
           *
           * EIP-7702 puts 23 bytes at the account beginning 0xef0100 and then
           * the implementation address. A subscriber's account pointed at
           * 0x7702cb55… on Base while pointing at MetaMask's own 0x63c0c19a…
           * on Arbitrum, Optimism and Monad — another app had upgraded it
           * there, and MetaMask will not act on a delegation it does not
           * recognise. Nothing in the request shape could have shown that.
           */
          delegated_to: await readDelegationTarget(client, walletAddress as Address),
        },
        error: e,
      });
    }
  }

  if (failures.length > 0 && failures.length === targets.length) throw failures[0]!.error;
  return failures;
}
