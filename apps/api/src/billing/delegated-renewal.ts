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
  getDelegateAddress,
  decodePeriodTransferTerms,
} from "../lib/chain/delegation";
import { periodConsumed } from "../lib/rail";
import { advanceBridge } from "./bridge";
import { claimPeriod, releaseClaim, periodKeyFor } from "./claims";
import { getUsdcAddress } from "../lib/chain/contract";
import { fireWebhook } from "../lib/webhooks/delivery";
import { sendPaymentReceipt } from "../lib/email/receipt";
import { ids } from "../lib/ids";

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
  settlementTxHash: Hex,
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
      cancel_reason: "Payment failed after maximum retries",
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
    | "error";
  chain?: string;
  txHash?: string;
  detail?: string;
};

/// One full cross-chain renewal sweep. The billing cron runs it right after the
/// Arc-allowance pass (runner.ts); the dev integration harness calls it directly
/// to validate the real redeem → bridge → settle path end to end.
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

  // A subscription's granted mandates: each cycle pays from ONE chain.
  const bySub = new Map<string, RenewalMandate[]>();
  for (const m of mandates) {
    if (!m.subscriptionId) continue;
    const arr = bySub.get(m.subscriptionId) ?? [];
    arr.push(m);
    bySub.set(m.subscriptionId, arr);
  }

  for (const group of bySub.values()) {
    const sub = group[0].subscription;
    // Skip cancelled/not-due subs AND any sub whose plan was closed (deleted).
    // past_due is still chargeable: it means earlier attempts failed, not that the
    // subscription is over. Excluding it here is how dunning quietly stops.
    if (
      !sub ||
      !["active", "past_due"].includes(sub.status) ||
      sub.currentPeriodEnd > now ||
      sub.plan.archived
    ) {
      continue;
    }
    const periodDur = group[0].periodDuration;
    const periodKey = periodKeyFor(sub);
    let claimed = false;
    let movedFunds = false;

    try {
      // 0. Resume an in-flight bridge before any fresh pull — never re-pull while a
      //    period's funds are already with the relayer (pulled) or burned & awaiting mint.
      const pending = await prisma.bridgeTransfer.findFirst({
        where: { subscriptionId: sub.id, status: { in: ["pulled", "burned"] } },
      });
      if (pending) {
        const mintTx = await advanceBridge(pending, (tx) =>
          recordRenewalSettled(sub, pending.mandateId, pending.grossAmount, tx, undefined,
            chainKeyForId(pending.chainId) ?? "source", periodDur, pending.id)
        );
        outcomes.push({
          subscriptionId: sub.subscriptionId,
          result: mintTx ? "settled" : "bridge_pending",
          chain: chainKeyForId(pending.chainId) ?? "source",
          txHash: mintTx ?? pending.burnTxHash ?? undefined,
          detail: mintTx ? "resumed bridge → minted on Arc" : `resumed (${pending.status}) — mint pending, re-run pass`,
        });
        continue;
      }

      const amount = group[0].periodAmount;
      const fee = (amount * platformFeeBps()) / 10_000n;
      const merchantShare = amount - fee;
      const creator = sub.merchant.walletAddress as Address;
      const allowedChainKeys = group
        .map((m) => chainKeyForId(m.chainId))
        .filter((k): k is string => !!k);

      // Single-chain selection among granted chains that currently hold enough
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
        continue;
      }
      const chosenKey = selection.chain.kind === "arc" ? "arc" : selection.chain.key;
      const chosenMandate = group.find((m) => chainKeyForId(m.chainId) === chosenKey);
      if (!chosenMandate) {
        outcomes.push({ subscriptionId: sub.subscriptionId, result: "skipped", detail: `no mandate for ${chosenKey}` });
        continue;
      }

      // The signed context is authoritative for the cap. If this period's pull
      // would exceed it (a mandate granted for less than the plan charges), don't
      // even attempt the redeem — it would revert ERC20PeriodTransferEnforcer:
      // transfer-amount-exceeded on-chain. Surface it as a distinct outcome.
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
        continue;
      }

      // And whether this period is already spent. The enforcer is the real guard
      // — it will reject a second redeem either way — but learning that from a
      // reverted transaction costs the relayer gas every time, and the grant's
      // own schedule answers it for free. Observed on a real subscription: the
      // checkout redeemed the delegation, the renewal pass an hour later tried
      // anyway, and paid for the revert to be told so.
      if (cap && periodConsumed(chosenMandate, cap)) {
        outcomes.push({
          subscriptionId: sub.subscriptionId,
          result: "period_consumed",
          chain: chosenKey,
          detail: "delegation's current period was already redeemed — retries next period",
        });
        continue;
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
        continue;
      }
      claimed = true;

      if (chosenKey === "arc") {
        // Settle on Arc: transfer the merchant share (and fee) straight to creator/treasury.
        const settle = await redeemPeriodicTransfer({
          chainId: chosenMandate.chainId,
          delegationManager: chosenMandate.delegationManager as Address,
          context: chosenMandate.context as Hex,
          delegate: chosenMandate.delegateAddress as Address,
          token: getUsdcAddress(),
          recipient: creator,
          amount: merchantShare,
        });
        movedFunds = true;
        if (fee > 0n) {
          await redeemPeriodicTransfer({
            chainId: chosenMandate.chainId,
            delegationManager: chosenMandate.delegationManager as Address,
            context: chosenMandate.context as Hex,
            delegate: chosenMandate.delegateAddress as Address,
            token: getUsdcAddress(),
            recipient: treasuryAddress(),
            amount: fee,
          });
        }
        await recordRenewalSettled(sub, chosenMandate.id, amount, settle.txHash, settle.blockNumber, "arc", periodDur);
        console.log(`[billing/tier2] renewed ${sub.subscriptionId} on Arc (tx ${settle.txHash})`);
        outcomes.push({ subscriptionId: sub.subscriptionId, result: "settled", chain: "arc", txHash: settle.txHash });
      } else {
        // Source chain: pull one period to the relayer and PERSIST (status "pulled")
        // BEFORE burning, so a burn failure is resumable and the period is never
        // re-pulled. advanceBridge then burns + attests + mints.
        const source = getSourceChain(chosenKey);
        await redeemPeriodicTransfer({
          chainId: chosenMandate.chainId,
          delegationManager: chosenMandate.delegationManager as Address,
          context: chosenMandate.context as Hex,
          delegate: chosenMandate.delegateAddress as Address,
          token: source.usdc,
          recipient: getDelegateAddress(),
          amount, // pull the full period; fee remains in the relayer's source balance
        });
        movedFunds = true; // from here the bridge owns the period; failures resume, don't re-pull
        const bridge = await prisma.bridgeTransfer.create({
          data: {
            subscriptionId: sub.id,
            mandateId: chosenMandate.id,
            chainId: chosenMandate.chainId,
            sourceDomain: source.domain,
            grossAmount: amount,
            bridgedAmount: merchantShare,
            mintRecipient: creator,
            status: "pulled",
          },
        });
        const mintTx = await advanceBridge(bridge, (tx) =>
          recordRenewalSettled(sub, bridge.mandateId, bridge.grossAmount, tx, undefined,
            chosenKey, periodDur, bridge.id)
        );
        outcomes.push({
          subscriptionId: sub.subscriptionId,
          result: mintTx ? "settled" : "bridge_pending",
          chain: chosenKey,
          txHash: mintTx ?? undefined,
          detail: mintTx
            ? "source → pulled + bridged + minted on Arc"
            : "source → pulled + burned, mint pending (re-run pass to resume)",
        });
      }
    } catch (e) {
      // If we claimed the period but moved no funds, release it so the next pass
      // can retry. Once funds moved, the bridge owns the period (resume, never
      // re-pull) so the claim stays put.
      if (claimed && !movedFunds) await releaseClaim(sub.id, periodKey).catch(() => {});
      const detail = e instanceof Error ? e.message : String(e);
      // We pre-check the cap above, so a transfer-amount-exceeded here means the
      // amount fit the cap but this mandate's current period was already spent
      // (an earlier pass, or a sibling subscription sharing the delegation). It
      // resolves itself next period — flag it as such rather than a hard error.
      if (detail.includes("ERC20PeriodTransferEnforcer:transfer-amount-exceeded")) {
        console.warn(`[billing/tier2] ${sub.subscriptionId} period already redeemed — retry next period`);
        outcomes.push({
          subscriptionId: sub.subscriptionId,
          result: "period_consumed",
          detail: "delegation's current period was already redeemed — retries next period",
        });
      } else {
        console.error(`[billing/tier2] renewal failed for ${sub.subscriptionId}:`, detail);
        outcomes.push({ subscriptionId: sub.subscriptionId, result: "error", detail });
      }
    }
  }

  return outcomes;
}
