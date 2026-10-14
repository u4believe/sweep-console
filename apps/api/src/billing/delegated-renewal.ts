// Tier-2 renewal pass (ERC-7715 periodic transfer + CCTP) — flag-gated, isolated
// from processRenewals().
//
// MetaMask end-user wallets only grant transfer-type 7715 permissions, so each
// due subscription pays from ONE granted chain by a single capped `transfer`:
//   • chosen chain = Arc → redeem the Arc mandate to transfer the merchant share
//     (and fee) straight to the creator / treasury on Arc — settles in one pass.
//   • chosen chain ≠ Arc → TWO phases. (1) redeem the source mandate to transfer
//     one period to the RELAYER, burn the merchant share via CCTP, and PERSIST a
//     BridgeTransfer (funds have left the source chain; period NOT yet advanced).
//     (2) once Iris attests, mint on Arc to the creator and settle. If phase 2
//     fails, the BridgeTransfer stays "burned" and the next pass RESUMES it
//     (re-attest + mint) instead of re-pulling — so funds are never burned-and-lost
//     and the period cap can't be hit by a retry.
//
// Caveats cap each redemption to one period. The cross-chain platform fee stays in
// the relayer's source-chain balance (swept to treasury out of band).

import type { Address, Hex } from "viem";
import type { Prisma, BridgeTransfer } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { selectPaymentChain } from "../lib/gateway/selector";
import { chainKeyForId, getSourceChain } from "../lib/gateway/chains";
import {
  redeemPeriodicTransfer,
  decodePeriodTransferTerms,
  mandateCovers,
  periodicTransferExecution,
} from "../lib/chain/delegation";
import { ownerOfDelegateMsca, redeemBatchViaSelfBundler } from "../lib/chain/delegate-msca";
import { settlementTargetFor } from "../lib/chain/settlement-target";
import { periodConsumed } from "../lib/rail";
import { advanceBridge } from "./bridge";
import { payFeeToTreasury } from "../lib/chain/fee-payout";
import { claimPeriod, releaseClaim, periodKeyFor } from "./claims";
import { getUsdcAddress } from "../lib/chain/contract";
import { fireWebhook } from "../lib/webhooks/delivery";
import { sendPaymentReceipt } from "../lib/email/receipt";
import { ids } from "../lib/ids";
import { getSettlementAddress } from "../lib/chain/signers";

function platformFeeBps(): bigint {
  return BigInt(process.env.PLATFORM_FEE_BPS ?? "0");
}
function treasuryAddress(): Address {
  const t = process.env.PLATFORM_TREASURY_ADDRESS;
  if (!t) throw new Error("PLATFORM_TREASURY_ADDRESS not set");
  return t as Address;
}

type RenewalMandate = Prisma.RenewalDelegationGetPayload<{
  include: { subscription: { include: { merchant: true; plan: true } } };
}>;
type RenewalSub = NonNullable<RenewalMandate["subscription"]>;

/// Advance the billing period, record the Payment, stamp the mandate, and (for a
/// cross-chain renewal) mark the BridgeTransfer minted — all atomically — then fire
/// the renewal + payment webhooks. The creator is always paid on Arc, so chain="arc".
async function recordRenewalSettled(
  sub: RenewalSub,
  mandateId: string,
  grossAmount: bigint,
  // Nullable: Circle's auto-relayer may have delivered the mint, and an RPC that
  // will not serve logs leaves the arrival certain but the transaction unnamed.
  settlementTxHash: Hex | null,
  settlementBlock: bigint | undefined,
  sourceChain: string,
  periodDurationSec: number,
  bridgeId?: string
): Promise<void> {
  const newPeriodEnd = new Date(sub.currentPeriodEnd.getTime() + periodDurationSec * 1000);
  const [, renewalPayment] = await prisma.$transaction([
    prisma.subscription.update({
      where: { id: sub.id },
      data: {
        currentPeriodStart: sub.currentPeriodEnd,
        currentPeriodEnd: newPeriodEnd,
        // A subscription that fell behind and then paid is current again. Leaving
        // it past_due would keep dunning a paid-up subscriber and march it toward
        // the max-retry cancel on a counter that should have been cleared.
        status: "active",
        retryCount: 0,
      },
    }),
    prisma.payment.create({
      data: {
        paymentId: ids.payment(),
        merchantId: sub.merchantId,
        subscriptionId: sub.id,
        amount: grossAmount, // gross period; `fee` is the platform's cut
        currency: sub.plan.currency,
        status: "succeeded",
        type: "renewal",
        isTestMode: sub.isTestMode,
        txHash: settlementTxHash,
        ...(settlementBlock !== undefined ? { blockNumber: settlementBlock } : {}),
        chain: "arc",
      },
    }),
    prisma.renewalDelegation.update({
      where: { id: mandateId },
      data: { lastRedeemedAt: new Date(), lastRedeemTx: settlementTxHash },
    }),
    ...(bridgeId
      ? [
          prisma.bridgeTransfer.update({
            where: { id: bridgeId },
            data: { status: "minted", mintTxHash: settlementTxHash, mintedAt: new Date() },
          }),
        ]
      : []),
  ]);

  void sendPaymentReceipt(renewalPayment.id);

  await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "subscription.renewed", {
    subscription_id: sub.subscriptionId,
    plan_id: sub.plan.planId,
    amount: Number(grossAmount),
    currency: sub.plan.currency,
    tx_hash: settlementTxHash,
    chain: "arc",
    source_chain: sourceChain,
    current_period_end: newPeriodEnd.toISOString(),
  });
  await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "payment.succeeded", {
    subscription_id: sub.subscriptionId,
    amount: Number(grossAmount),
    currency: sub.plan.currency,
    tx_hash: settlementTxHash,
    type: "renewal",
  });
}

/// Per-subscription outcome of a renewal pass — surfaced by the dev integration
/// harness so a no-op is explained (insufficient funds, attestation pending, …).
/// A renewal that could not be collected. Ported from the Arc allowance pass,
/// which used to own dunning — with that gone, this is the only place a
/// subscription can fall behind, and subscription.past_due the only place the
/// merchant hears about it.
///
/// The subscription stays DUE either way, so the next pass retries it. After
/// MAX_RENEWAL_RETRIES it is closed: retrying a wallet that has been empty for a
/// week is just noise to everyone involved.
const MAX_RENEWAL_RETRIES = 7;

async function markRenewalFailed(sub: RenewalSub, amount: bigint, reason: string): Promise<void> {
  const attempts = sub.retryCount + 1;
  if (attempts >= MAX_RENEWAL_RETRIES) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelReason: "Payment failed after maximum retries",
        retryCount: attempts,
      },
    });
    await prisma.renewalDelegation.updateMany({
      where: { subscriptionId: sub.id, status: "active" },
      data: { status: "revoked" },
    });
    await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "subscription.cancelled", {
      subscription_id: sub.subscriptionId,
      plan_id: sub.plan.planId,
      cancel_reason: "Payment failed after maximum retries",
      cancelled_at: new Date().toISOString(),
    });
    console.log(`[billing/tier2] cancelled ${sub.subscriptionId} after ${attempts} failed renewals`);
    return;
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "past_due", retryCount: attempts },
  });
  await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "subscription.past_due", {
    subscription_id: sub.subscriptionId,
    plan_id: sub.plan.planId,
    amount: Number(amount),
    currency: sub.plan.currency,
    attempt: attempts,
    reason,
  });
  await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "payment.failed", {
    subscription_id: sub.subscriptionId,
    plan_id: sub.plan.planId,
    amount: Number(amount),
    currency: sub.plan.currency,
    type: "renewal",
    attempt: attempts,
    reason,
  });
  console.warn(`[billing/tier2] ${sub.subscriptionId} past_due (attempt ${attempts}): ${reason}`);
}

export type RenewalOutcome = {
  subscriptionId: string;
  result:
    | "settled"
    | "bridge_pending"
    | "insufficient_funds"
    | "skipped"
    // redeem amount > the cap baked into the signed mandate (a mis-granted
    // delegation, caught before we attempt the on-chain redeem)
    | "over_cap"
    // amount ≤ cap, but the mandate's current period was already redeemed (an
    // earlier pass or a sibling sub sharing the delegation) — retries next period
    | "period_consumed"
    // due, but every chain's authorization has been revoked — by the subscriber
    // in the portal, or in their own wallet. Nothing left to redeem, so it goes
    // to dunning rather than staying invisible to this pass.
    | "no_grants"
    | "error";
  chain?: string;
  txHash?: string;
  detail?: string;
};

/// One full cross-chain renewal sweep. The billing cron runs it right after the
/// Arc-allowance pass (runner.ts); the dev integration harness calls it directly
/// to validate the real redeem → bridge → settle path end to end.
/**
 * A renewal that passed every check and claimed its period, awaiting its redeem.
 *
 * The pass used to do everything for one subscription before looking at the
 * next, which meant one redeem transaction per subscriber. With an MSCA
 * delegate that is the expensive shape: ~134k of fixed ERC-4337 overhead per
 * handleOps plus ~38.5k per operation, measured, so a lone redeem runs 172k.
 * Collected and submitted together, 20 due renewals come to ~45k each and 50
 * to ~41k — the premium that buys a rotatable delegate address gets paid once
 * per pass instead of once per subscriber.
 */
type PreparedRenewal = {
  sub: RenewalSub;
  group: RenewalMandate[];
  chosenMandate: RenewalMandate;
  chosenKey: string;
  amount: bigint;
  fee: bigint;
  merchantShare: bigint;
  creator: Address;
  periodKey: string;
  periodDur: number;
  /** Set once this renewal's funds have actually been pulled. */
  redeemed: boolean;
};

/**
 * Turn the enforcer's "period already spent" revert into its own outcome.
 *
 * The cap is pre-checked, so a transfer-amount-exceeded here means the amount
 * fit but this mandate's current period was already spent — by an earlier
 * pass, or by a sibling subscription sharing the delegation. It resolves itself
 * next period, so it is not an error.
 */
function outcomeForRedeemError(sub: RenewalSub, detail: string): RenewalOutcome {
  if (detail.includes("ERC20PeriodTransferEnforcer:transfer-amount-exceeded")) {
    console.warn(`[billing/tier2] ${sub.subscriptionId} period already redeemed — retry next period`);
    return {
      subscriptionId: sub.subscriptionId,
      result: "period_consumed",
      detail: "delegation's current period was already redeemed — retries next period",
    };
  }
  console.error(`[billing/tier2] renewal failed for ${sub.subscriptionId}:`, detail);
  return { subscriptionId: sub.subscriptionId, result: "error", detail };
}

/// Every check a renewal must pass, up to and including claiming the period.
/// Returns null when it has already pushed a terminal outcome.
async function prepareRenewal(
  group: RenewalMandate[],
  now: Date,
  outcomes: RenewalOutcome[]
): Promise<PreparedRenewal | null> {
  const sub = group[0]!.subscription;
  // Skip cancelled/not-due subs AND any sub whose plan was closed (deleted).
  // past_due is still chargeable: it means earlier attempts failed, not that the
  // subscription is over. Excluding it here is how dunning quietly stops.
  if (
    !sub ||
    !["active", "past_due"].includes(sub.status) ||
    sub.currentPeriodEnd > now ||
    sub.plan.archived
  ) {
    return null;
  }
  const periodDur = group[0]!.periodDuration;
  const periodKey = periodKeyFor(sub);

  try {
    // 0. Resume an in-flight bridge before any fresh pull — never re-pull while a
    //    period's funds are already with the relayer (pulled) or burned & awaiting mint.
    const pending = await prisma.bridgeTransfer.findFirst({
      where: { subscriptionId: sub.id, status: { in: ["pulled", "burned"] } },
    });
    if (pending) {
      const outcome = await advanceBridge(pending, (tx) =>
        recordRenewalSettled(sub, pending.mandateId, pending.grossAmount, tx, undefined,
          chainKeyForId(pending.chainId) ?? "source", periodDur, pending.id)
      );
      outcomes.push({
        subscriptionId: sub.subscriptionId,
        result: outcome.settled ? "settled" : "bridge_pending",
        chain: chainKeyForId(pending.chainId) ?? "source",
        txHash: (outcome.settled ? outcome.mintTxHash : null) ?? pending.burnTxHash ?? undefined,
        detail: outcome.settled
          ? outcome.mintTxHash
            ? "resumed bridge → minted on Arc"
            : "resumed bridge → delivered on Arc, mint tx unresolved"
          : `resumed (${pending.status}) — mint pending, re-run pass`,
      });
      return null;
    }

    // Charge what the plan LISTS, not what the grant permits. The grant's
    // periodAmount is the subscriber's signed CEILING, so reading it collected
    // the maximum the wallet allowed and a creator changing their price changed
    // nothing. NOT clamped by the cap either: a clamp made the over_cap guard
    // below unreachable, so a price above someone's signed cap quietly collected
    // the old cap forever instead of asking them to re-authorize.
    const amount = sub.amount ?? sub.plan.amount;
    const fee = (amount * platformFeeBps()) / 10_000n;
    const merchantShare = amount - fee;
    const creator = sub.merchant.walletAddress as Address;

    // Only chains whose grant actually covers this price are candidates.
    // Selecting by balance first and checking the cap afterwards skipped a
    // subscriber whose covering chain held less than a stale one.
    const covering = group.filter((m) =>
      mandateCovers({ periodAmount: m.periodAmount, periodDuration: m.periodDuration }, amount, periodDur)
    );
    const allowedChainKeys = covering
      .map((m) => chainKeyForId(m.chainId))
      .filter((k): k is string => !!k);

    if (allowedChainKeys.length === 0) {
      // The creator raised the price above what this subscriber authorized.
      // Retrying cannot fix it and only the subscriber can, so this must NOT go
      // to dunning: that would spend the ladder and cancel them for someone
      // else's decision.
      console.warn(
        `[billing/tier2] ${sub.subscriptionId} needs re-authorization: price ${amount} exceeds every ` +
          `signed cap (${group.map((m) => `${chainKeyForId(m.chainId)}:${m.periodAmount}`).join(", ")})`
      );
      outcomes.push({
        subscriptionId: sub.subscriptionId,
        result: "over_cap",
        detail:
          `price ${amount} exceeds the signed cap on every granted chain — the subscriber must ` +
          `re-authorize before this can be collected`,
      });
      return null;
    }

    // Single-chain selection among covering chains that currently hold enough
    // AND where the subscriber's smart account is deployed (redeemable).
    const selection = await selectPaymentChain(sub.walletAddress as Hex, {
      amount,
      allowedChainKeys,
      requireDeployedAccount: true,
    });
    if (!selection.sufficient) {
      await markRenewalFailed(sub, amount, "no granted chain holds a full period");
      outcomes.push({
        subscriptionId: sub.subscriptionId,
        result: "insufficient_funds",
        detail: `subscriber holds < ${amount} on every granted chain (tried: ${allowedChainKeys.join(", ") || "none"})`,
      });
      return null;
    }
    const chosenKey = selection.chain.kind === "arc" ? "arc" : selection.chain.key;
    const chosenMandate = group.find((m) => chainKeyForId(m.chainId) === chosenKey);
    if (!chosenMandate) {
      outcomes.push({ subscriptionId: sub.subscriptionId, result: "skipped", detail: `no mandate for ${chosenKey}` });
      return null;
    }

    // The signed context is authoritative for the cap. Attempting a redeem that
    // exceeds it would revert ERC20PeriodTransferEnforcer on chain.
    const cap = decodePeriodTransferTerms(chosenMandate.context as Hex, chosenMandate.token as Address);
    if (cap && amount > cap.periodAmount) {
      console.warn(
        `[billing/tier2] ${sub.subscriptionId} renewal ${amount} > signed cap ${cap.periodAmount} on ${chosenKey}`
      );
      outcomes.push({
        subscriptionId: sub.subscriptionId,
        result: "over_cap",
        chain: chosenKey,
        detail: `renewal amount ${amount} exceeds the signed per-period cap ${cap.periodAmount} on ${chosenKey}`,
      });
      return null;
    }

    // And whether this period is already spent. The enforcer is the real guard,
    // but learning that from a reverted transaction costs gas every time and the
    // grant's own schedule answers it for free. Observed on a real subscription:
    // checkout redeemed the delegation, the pass an hour later tried anyway and
    // paid for the revert to be told so.
    if (cap && periodConsumed(chosenMandate, cap)) {
      outcomes.push({
        subscriptionId: sub.subscriptionId,
        result: "period_consumed",
        chain: chosenKey,
        detail: "delegation's current period was already redeemed — retries next period",
      });
      return null;
    }

    // Claim this period before moving any funds — exactly one path/chain charges
    // a due period. If the Arc allowance pass (or a concurrent run) already owns
    // it, skip rather than charge from a second granted chain.
    if (!(await claimPeriod(sub.id, periodKey))) {
      outcomes.push({
        subscriptionId: sub.subscriptionId,
        result: "skipped",
        detail: "this period was already charged on another chain/path",
      });
      return null;
    }

    return {
      sub, group, chosenMandate, chosenKey, amount, fee, merchantShare, creator,
      periodKey, periodDur, redeemed: false,
    };
  } catch (e) {
    // Nothing here moves funds, so a claim taken just above is safe to release.
    await releaseClaim(sub.id, periodKey).catch(() => {});
    outcomes.push(outcomeForRedeemError(sub, e instanceof Error ? e.message : String(e)));
    return null;
  }
}

/**
 * Pull the funds for every prepared renewal, batching where it is possible.
 *
 * Batching is only available to grants naming one of our MSCAs — an EOA
 * delegate signs its own transaction and there is nothing to batch into. And
 * only above one item: a lone MSCA redeem already goes through the self-bundler
 * via redeemPeriodicTransfer, and routing it through a batch of one would add
 * the grouping for none of the saving.
 */
async function redeemPrepared(prepared: PreparedRenewal[], outcomes: RenewalOutcome[]): Promise<void> {
  /// Arc settles directly to creator and treasury in two redeems and is
  /// self-contained, so it is never batched. Unreachable today — MetaMask will
  /// not sign a delegation on Arc, so no Arc grant exists.
  for (const p of prepared.filter((x) => x.chosenKey === "arc")) {
    try {
      const settle = await redeemPeriodicTransfer({
        chainId: p.chosenMandate.chainId,
        delegationManager: p.chosenMandate.delegationManager as Address,
        context: p.chosenMandate.context as Hex,
        delegate: p.chosenMandate.delegateAddress as Address,
        token: getUsdcAddress(),
        recipient: p.creator,
        amount: p.merchantShare,
      });
      p.redeemed = true;
      if (p.fee > 0n) {
        await redeemPeriodicTransfer({
          chainId: p.chosenMandate.chainId,
          delegationManager: p.chosenMandate.delegationManager as Address,
          context: p.chosenMandate.context as Hex,
          delegate: p.chosenMandate.delegateAddress as Address,
          token: getUsdcAddress(),
          recipient: treasuryAddress(),
          amount: p.fee,
        });
      }
      await recordRenewalSettled(p.sub, p.chosenMandate.id, p.amount, settle.txHash, settle.blockNumber, "arc", p.periodDur);
      console.log(`[billing/tier2] renewed ${p.sub.subscriptionId} on Arc (tx ${settle.txHash})`);
      outcomes.push({ subscriptionId: p.sub.subscriptionId, result: "settled", chain: "arc", txHash: settle.txHash });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // Only release when nothing moved. Once the first redeem lands the period
      // is spent on chain and a retry would be refused by the enforcer anyway.
      if (!p.redeemed) await releaseClaim(p.sub.id, p.periodKey).catch(() => {});
      outcomes.push(outcomeForRedeemError(p.sub, detail));
    }
  }

  // Source-chain renewals, grouped by the transaction they could share: one
  // chain, one delegate. A batch is one handleOps, and handleOps is per chain.
  const groups = new Map<string, PreparedRenewal[]>();
  for (const p of prepared.filter((x) => x.chosenKey !== "arc")) {
    const key = `${p.chosenMandate.chainId}:${(p.chosenMandate.delegateAddress as string).toLowerCase()}`;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }

  for (const items of groups.values()) {
    const first = items[0]!;
    const chainId = first.chosenMandate.chainId;
    const delegate = first.chosenMandate.delegateAddress as Address;
    const held = ownerOfDelegateMsca(delegate);

    if (held && items.length > 1) {
      const source = getSourceChain(first.chosenKey);
      try {
        const out = await redeemBatchViaSelfBundler({
          chainId,
          delegate,
          owner: held.owner,
          items: items.map((p) => ({
            delegationManager: p.chosenMandate.delegationManager as Address,
            context: p.chosenMandate.context as Hex,
            // Settlement, not the delegate: new grants pin `payee` there and
            // older ones carry no payee caveat and accept it just the same.
            ...periodicTransferExecution(
              source.usdc,
              settlementTargetFor(p.chosenMandate.chainId, p.chosenMandate.context as Hex).address,
              p.amount
            ),
            ref: p.sub.id,
          })),
        });
        for (const p of items) {
          const r = out.results.get(p.sub.id);
          if (r?.success) {
            p.redeemed = true;
            continue;
          }
          /// An operation that reverted inside a successful handleOps moved no
          /// funds, so its claim is released and it retries next pass. A missing
          /// event is treated the same way: without one we cannot say the pull
          /// happened, and assuming it did would strand the period.
          await releaseClaim(p.sub.id, p.periodKey).catch(() => {});
          outcomes.push({
            subscriptionId: p.sub.subscriptionId,
            result: "error",
            chain: p.chosenKey,
            detail: r
              ? `redeemDelegations reverted inside the batch (tx ${out.txHash}) — retries next pass`
              : `no UserOperationEvent for this redeem in ${out.txHash} — treated as not pulled`,
          });
        }
      } catch (e) {
        // The whole transaction failed, so nothing was pulled for anyone in it.
        const detail = e instanceof Error ? e.message : String(e);
        for (const p of items) {
          await releaseClaim(p.sub.id, p.periodKey).catch(() => {});
          outcomes.push(outcomeForRedeemError(p.sub, detail));
        }
      }
      continue;
    }

    // One at a time: an EOA delegate, or a single MSCA redeem that
    // redeemPeriodicTransfer already routes through the self-bundler.
    for (const p of items) {
      const source = getSourceChain(p.chosenKey);
      try {
        await redeemPeriodicTransfer({
          chainId: p.chosenMandate.chainId,
          delegationManager: p.chosenMandate.delegationManager as Address,
          context: p.chosenMandate.context as Hex,
          delegate: p.chosenMandate.delegateAddress as Address,
          token: source.usdc,
          // Whatever this grant pins — see the note in cctp-activate.ts.
          recipient: settlementTargetFor(
            p.chosenMandate.chainId,
            p.chosenMandate.context as Hex
          ).address,
          // Still the full period in one redemption: splitting it would double
          // the redeem gas and the enforcer counts both against the same period
          // cap anyway. The fee moves on in the next step instead.
          amount: p.amount,
        });
        p.redeemed = true;
      } catch (e) {
        await releaseClaim(p.sub.id, p.periodKey).catch(() => {});
        outcomes.push(outcomeForRedeemError(p.sub, e instanceof Error ? e.message : String(e)));
      }
    }
  }
}

/**
 * Bridge a pulled period to Arc and settle it.
 *
 * From here the bridge owns the period: every failure resumes rather than
 * re-pulls, so the claim stays put whatever happens.
 */
async function finishSourceRenewal(p: PreparedRenewal, outcomes: RenewalOutcome[]): Promise<void> {
  try {
    const source = getSourceChain(p.chosenKey);
    const bridge = await prisma.bridgeTransfer.create({
      data: {
        subscriptionId: p.sub.id,
        mandateId: p.chosenMandate.id,
        chainId: p.chosenMandate.chainId,
        sourceDomain: source.domain,
        grossAmount: p.amount,
        bridgedAmount: p.merchantShare,
        mintRecipient: p.creator,
        status: "pulled",
      },
    });

    const outcome = await advanceBridge(bridge, (tx) =>
      recordRenewalSettled(p.sub, bridge.mandateId, bridge.grossAmount, tx, undefined,
        p.chosenKey, p.periodDur, bridge.id)
    );
    outcomes.push({
      subscriptionId: p.sub.subscriptionId,
      result: outcome.settled ? "settled" : "bridge_pending",
      chain: p.chosenKey,
      txHash: (outcome.settled ? outcome.mintTxHash : null) ?? undefined,
      detail: outcome.settled
        ? outcome.mintTxHash
          ? "source → pulled + bridged + minted on Arc"
          : "source → pulled + bridged, delivered on Arc with no mint tx to cite"
        : "source → pulled + burned, mint pending (re-run pass to resume)",
    });
  } catch (e) {
    // The funds are pulled. The claim stays, and the next pass resumes from
    // whatever row exists rather than pulling again.
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[billing/tier2] renewal failed after the pull for ${p.sub.subscriptionId}:`, detail);
    outcomes.push({ subscriptionId: p.sub.subscriptionId, result: "error", chain: p.chosenKey, detail });
  }
}

export async function runDelegatedRenewalsOnce(): Promise<RenewalOutcome[]> {
  const now = new Date();
  const outcomes: RenewalOutcome[] = [];

  const mandates = await prisma.renewalDelegation.findMany({
    // `mode: "hosted"` is redundant beside `subscriptionId: { not: null }` today —
    // rail mandates have no subscription. It is here so the exclusion is a stated
    // rule rather than a happy accident: this cron owns the clock for hosted
    // mandates only, and a rail mandate charged from here would collide with the
    // developer's own charge call and burn the mandate's one redeem per period.
    where: {
      status: "active",
      expiry: { gt: now },
      subscriptionId: { not: null },
      mode: "hosted",
    },
    include: { subscription: { include: { merchant: true, plan: true } } },
  });

  // Due subscriptions with NO redeemable grant left.
  //
  // The sweep below is grant-driven, so a subscription whose every grant was
  // revoked produces no group and is simply never seen — not failing, invisible.
  // It would sit at its status forever, never charged and never retried, while
  // the creator kept serving someone for free. That happens two ordinary ways:
  // the subscriber turns off their last chain in the portal, and reconciliation
  // finds they disabled the delegation in their own wallet.
  //
  // Funnel them into the dunning that already exists rather than inventing a
  // second lifecycle: markRenewalFailed retries, fires subscription.past_due, and
  // cancels after MAX_RENEWAL_RETRIES — which is the right end for a subscription
  // whose authorization is gone and which only the subscriber can restore.
  const grantless = await prisma.subscription.findMany({
    where: {
      status: { in: ["active", "past_due"] },
      currentPeriodEnd: { lte: now },
      plan: { archived: false },
      renewalDelegations: { none: { status: "active" } },
    },
    include: { merchant: true, plan: true },
  });
  for (const sub of grantless) {
    await markRenewalFailed(sub, sub.amount ?? sub.plan.amount, "no active grant on any chain");
    outcomes.push({
      subscriptionId: sub.subscriptionId,
      result: "no_grants",
      detail: "every chain's authorization was revoked — nothing left to redeem",
    });
  }

  // A subscription's granted mandates: each cycle pays from ONE chain.
  const bySub = new Map<string, RenewalMandate[]>();
  for (const m of mandates) {
    if (!m.subscriptionId) continue;
    const arr = bySub.get(m.subscriptionId) ?? [];
    arr.push(m);
    bySub.set(m.subscriptionId, arr);
  }

  /**
   * Three phases, so that redeems can share a transaction.
   *
   * This was one loop doing everything for a subscriber before looking at the
   * next, which fixed one redeem transaction per subscription. Splitting it at
   * the pull is what lets several redeems ride in one handleOps — see
   * PreparedRenewal for the arithmetic.
   *
   * The ordering rule that made the old loop safe is unchanged and is why the
   * split is here and not elsewhere: a claim taken before the pull is released
   * when the pull does not happen, and kept once it does, because from that
   * point the bridge owns the period and failures resume rather than re-pull.
   * Phase one claims, phase two pulls, phase three bridges — so exactly one
   * boundary in the whole pass can both hold a claim and have moved nothing.
   */
  const prepared: PreparedRenewal[] = [];
  for (const group of bySub.values()) {
    const p = await prepareRenewal(group, now, outcomes);
    if (p) prepared.push(p);
  }

  await redeemPrepared(prepared, outcomes);

  for (const p of prepared) {
    // Arc finished inside the redeem phase; an unpulled renewal has already had
    // its claim released and its outcome recorded.
    if (!p.redeemed || p.chosenKey === "arc") continue;
    await finishSourceRenewal(p, outcomes);
  }

  return outcomes;
}
