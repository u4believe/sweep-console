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
import { chainKeyForId, getSourceChain, ARC_DOMAIN } from "../lib/gateway/chains";
import {
  redeemPeriodicTransfer,
  relayerBridgeToArc,
  getDelegateAddress,
  decodePeriodTransferTerms,
} from "../lib/chain/delegation";
import { claimPeriod, releaseClaim, periodKeyFor } from "./claims";
import { fetchAttestation, getTokenMessenger, receiveOnArc } from "../lib/gateway/cctp";
import { getUsdcAddress } from "../lib/chain/contract";
import { fireWebhook } from "../lib/webhooks/delivery";
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
  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: sub.id },
      data: { currentPeriodStart: sub.currentPeriodEnd, currentPeriodEnd: newPeriodEnd },
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

/// Phase 2 of a source renewal: fetch the burn's attestation and mint on Arc, then
/// settle. Returns the mint tx hash if minted (settled this pass), or null if the
/// attestation isn't ready yet (the BridgeTransfer stays "burned" and resumes next
/// pass). Only a real mint failure throws.
async function mintAndSettleBridge(
  bridge: BridgeTransfer,
  sub: RenewalSub,
  periodDurationSec: number
): Promise<string | null> {
  if (!bridge.burnTxHash) throw new Error(`bridge ${bridge.id} has no burnTxHash`);
  let att;
  try {
    att = await fetchAttestation(bridge.sourceDomain, bridge.burnTxHash as Hex, {
      timeoutMs: 90_000,
      pollMs: 8_000,
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("Timed out")) {
      console.log(`[billing/tier2] bridge ${bridge.burnTxHash} attestation pending — will resume`);
      return null;
    }
    throw e;
  }
  const mintTxHash = await receiveOnArc(att);
  await recordRenewalSettled(
    sub,
    bridge.mandateId,
    bridge.grossAmount,
    mintTxHash,
    undefined,
    chainKeyForId(bridge.chainId) ?? "source",
    periodDurationSec,
    bridge.id
  );
  console.log(`[billing/tier2] bridge minted + settled ${sub.subscriptionId} (mint ${mintTxHash})`);
  return mintTxHash;
}

/// Drive an in-flight source bridge to completion from whatever phase it's in:
/// "pulled" (funds with the relayer) → burn → "burned" → attest + mint → settle.
/// Each step is persisted, so a failure resumes here next pass and the subscriber's
/// period is NEVER pulled twice. Returns the mint tx hash, or null if still pending.
async function advanceBridge(
  bridge: BridgeTransfer,
  sub: RenewalSub,
  periodDurationSec: number
): Promise<string | null> {
  let b = bridge;
  if (b.status === "pulled") {
    const chainKey = chainKeyForId(b.chainId);
    if (!chainKey || chainKey === "arc") throw new Error(`bridge ${b.id} has a non-source chain ${b.chainId}`);
    const source = getSourceChain(chainKey);
    const burn = await relayerBridgeToArc({
      chainId: b.chainId,
      token: source.usdc,
      tokenMessenger: getTokenMessenger(chainKey),
      amount: b.bridgedAmount,
      destinationDomain: ARC_DOMAIN,
      mintRecipient: b.mintRecipient as Address,
      // Fast (soft finality, small maxFee) so cross-chain renewals settle in
      // seconds like the first payment. Override with CCTP_RENEWAL_SPEED=standard
      // to trade speed for the free hard-finality path.
      speed: process.env.CCTP_RENEWAL_SPEED === "standard" ? "standard" : "fast",
    });
    b = await prisma.bridgeTransfer.update({
      where: { id: b.id },
      data: { status: "burned", burnTxHash: burn.burnTxHash },
    });
  }
  return mintAndSettleBridge(b, sub, periodDurationSec);
}

/// Per-subscription outcome of a renewal pass — surfaced by the dev integration
/// harness so a no-op is explained (insufficient funds, attestation pending, …).
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
    where: { status: "active", expiry: { gt: now }, subscriptionId: { not: null } },
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
    if (!sub || sub.status !== "active" || sub.currentPeriodEnd > now || sub.plan.archived) continue;
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
        const mintTx = await advanceBridge(pending, sub, periodDur);
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
        console.warn(`[billing/tier2] no granted chain holds ${amount} for ${sub.subscriptionId}`);
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
        const mintTx = await advanceBridge(bridge, sub, periodDur);
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
