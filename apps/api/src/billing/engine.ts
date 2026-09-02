import { addDays, addSeconds } from "date-fns";
import { prisma } from "../lib/prisma";
import {
  renewFromAllowance,
  settlePeriodOnChain,
  cancelOnChain,
  checkSubscriberFunds,
  settlementWindowSeconds,
  getOnChainSubscription,
  revertErrorName,
  describeChainError,
} from "../lib/chain/subscription";
import { fireWebhook } from "../lib/webhooks/delivery";
import { sendPaymentReceipt } from "../lib/email/receipt";
import { signWebhook } from "../lib/webhooks/sign";
import { getNextRetryAt } from "../lib/webhooks/delivery";
import { assertDeliverableUrl } from "../lib/webhooks/url-guard";
import { ids } from "../lib/ids";
import { claimPeriod, releaseClaim, periodKeyFor } from "./claims";

const MAX_RETRIES = 7;

const intervalDays: Record<string, number> = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };

// ─── Settlement sweep ─────────────────────────────────────────────────────────
// Escrowed first payments whose settlement window has closed are PUSHED to the
// merchant payout address (merchant share + platform fee in one transaction).

export async function settleDuePeriods() {
  const now = new Date();
  console.log(`[billing] settleDuePeriods starting at ${now.toISOString()}`);

  const due = await prisma.subscription.findMany({
    where: { escrowBalance: { gt: 0 }, settlementDeadline: { lte: now } },
    include: { plan: true, merchant: true },
  });

  console.log(`[billing] ${due.length} escrowed periods due for settlement`);

  for (const sub of due) {
    if (!sub.onChainSubId) {
      console.error(`[billing] ${sub.subscriptionId} has escrow but no onChainSubId — skipping`);
      continue;
    }

    try {
      // The DB row is a mirror of on-chain state and can drift — escrow may
      // already be 0 because the period settled, OR because the subscription was
      // cancelled outside this API (the contract lets the subscriber call
      // cancelSubscription() themselves, which refunds escrow to them). Either
      // way settlePeriod() can never succeed, so reconcile instead of retrying
      // forever. Status 4 = Cancelled; see ISubscriptionManager.Status.
      const onChain = await getOnChainSubscription(sub.onChainSubId);
      if (onChain.escrowBalance === 0n) {
        if (onChain.status === 4) {
          await reconcileCancelled(sub.id);
          console.warn(
            `[billing] ${sub.subscriptionId} cancelled on-chain (escrow refunded to subscriber) — ` +
              `marked cancelled, payment refunded. Cancel did not originate from this API.`
          );
        } else {
          await markSettled(sub.id);
          console.warn(
            `[billing] ${sub.subscriptionId} already settled on-chain (escrow 0) — reconciled DB, no webhook sent`
          );
        }
        continue;
      }

      const { txHash, blockNumber, merchantShare, platformFee } =
        await settlePeriodOnChain(sub.onChainSubId);

      await markSettled(sub.id);

      await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "payment.succeeded", {
        subscription_id: sub.subscriptionId,
        plan_id: sub.plan.planId,
        amount: Number(sub.escrowBalance),
        merchant_share: Number(merchantShare),
        platform_fee: Number(platformFee),
        currency: sub.plan.currency,
        type: "settlement",
        tx_hash: txHash,
        block_number: Number(blockNumber),
        chain: "arc",
      });

      console.log(`[billing] Settled ${sub.subscriptionId} tx=${txHash}`);
    } catch (e) {
      // Lost a race with another replica, or state changed between the read
      // above and the write. Re-read to decide how to reconcile.
      if (revertErrorName(e) === "NothingInEscrow") {
        const after = await getOnChainSubscription(sub.onChainSubId);
        if (after.status === 4) {
          await reconcileCancelled(sub.id);
          console.warn(`[billing] ${sub.subscriptionId} cancelled mid-sweep — reconciled as refunded`);
        } else {
          await markSettled(sub.id);
          console.warn(`[billing] ${sub.subscriptionId} settled concurrently — reconciled DB, no webhook sent`);
        }
        continue;
      }
      // Chain deadline hasn't passed even though ours has (clock skew, or the
      // window was extended on-chain). Retries on the next sweep.
      if (revertErrorName(e) === "SettlementNotDue") {
        console.warn(`[billing] ${sub.subscriptionId} not yet due on-chain — will retry`);
        continue;
      }
      console.error(`[billing] settlePeriod failed for ${sub.subscriptionId}: ${describeChainError(e)}`);
    }
  }
}

/// Clears the escrow mirror and completes the "pending" payment recorded at
/// checkout. Safe to run more than once for the same subscription.
async function markSettled(subscriptionRowId: string) {
  // Captured BEFORE the update, because updateMany returns no ids. This is also
  // what makes the receipt idempotent: a second run finds nothing pending, so
  // the list is empty and no second email goes out.
  const settling = await prisma.payment.findMany({
    where: {
      subscriptionId: subscriptionRowId,
      status: "pending",
      // "initial" is excluded: checkout already sent that receipt when the
      // payment was escrowed. Only escrowed RENEWALS get theirs here.
      type: { not: "initial" },
    },
    select: { id: true },
  });

  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: subscriptionRowId },
      data: { escrowBalance: 0n, settlementDeadline: null },
    }),
    // The escrowed payment was recorded as "pending" — settlement completes it
    prisma.payment.updateMany({
      where: { subscriptionId: subscriptionRowId, status: "pending" },
      data: { status: "succeeded" },
    }),
  ]);

  // The subscriber's receipt. Fire-and-forget — the charge is already settled
  // on-chain and must not be undone by a mail provider having a bad minute.
  for (const p of settling) void sendPaymentReceipt(p.id);
}

/// The subscription was cancelled directly on-chain (not through this API), so
/// the contract already refunded escrow to the subscriber. The merchant was
/// never paid — the pending payment must NOT be marked succeeded or it inflates
/// reported revenue. No webhook: we can't source a trustworthy tx hash or
/// refunded amount from a state read, and subscription.cancelled carries both.
async function reconcileCancelled(subscriptionRowId: string) {
  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: subscriptionRowId },
      data: {
        escrowBalance: 0n,
        settlementDeadline: null,
        status: "cancelled",
        cancelledAt: new Date(),
        cancelReason: "cancelled_on_chain",
      },
    }),
    prisma.payment.updateMany({
      where: { subscriptionId: subscriptionRowId, status: "pending" },
      data: { status: "refunded" },
    }),
  ]);
}

// ─── Renewals ─────────────────────────────────────────────────────────────────
// All renewals are allowance-based: the contract pulls from the subscriber's
// pre-approved USDC allowance and pushes the merchant share immediately.

export async function processRenewals() {
  const now = new Date();
  console.log(`[billing] processRenewals starting at ${now.toISOString()}`);

  const due = await prisma.subscription.findMany({
    // Never bill a closed plan, even if a sub's status flip is still in flight.
    where: { status: "active", currentPeriodEnd: { lte: now }, plan: { archived: false } },
    include: { plan: true, merchant: true },
  });

  console.log(`[billing] ${due.length} subscriptions due for renewal`);

  for (const sub of due) {
    await renewSubscription(sub, "renewal");
  }
}

type SubWithRelations = Awaited<
  ReturnType<typeof prisma.subscription.findMany<{
    include: { plan: true; merchant: true };
  }>>
>[number];

/// True when the subscriber granted a still-valid cross-chain renewal delegation —
/// such a sub is renewed Arc-FIRST here, and only falls to the delegated (CCTP)
/// pass when Arc is short, so we must not fail it on insufficient Arc funds.
async function hasActiveDelegation(subscriptionId: string, now: Date): Promise<boolean> {
  const count = await prisma.renewalDelegation.count({
    where: { subscriptionId, status: "active", expiry: { gt: now } },
  });
  return count > 0;
}

async function renewSubscription(sub: SubWithRelations, type: "renewal" | "initial") {
  const now = new Date();
  // Bill the subscription's snapshotted tier terms; fall back to the plan default
  // for older subs created before tier snapshots.
  const amount = sub.amount ?? sub.plan.amount;
  const interval = sub.interval ?? sub.plan.interval;
  const periodKey = periodKeyFor(sub);
  let claimed = false;
  try {
    if (!sub.onChainSubId) throw new Error(`Subscription ${sub.subscriptionId} has no onChainSubId`);

    const hasFunds = await checkSubscriberFunds(sub.walletAddress, amount);
    if (!hasFunds) {
      // Arc is short. If the subscriber enabled cross-chain, leave this sub DUE
      // (no past_due, no failed payment) so the delegated CCTP pass pulls one
      // period from a source chain. Otherwise it's a genuine Arc-only failure.
      if (await hasActiveDelegation(sub.id, now)) {
        console.log(`[billing] ${sub.subscriptionId} Arc-short — deferring to delegated pass`);
        return false;
      }
      throw new Error("Insufficient USDC balance or allowance");
    }

    // Claim this period before charging — if the cross-chain pass (or a concurrent
    // run) already owns it, skip rather than charge a second time.
    claimed = await claimPeriod(sub.id, periodKey);
    if (!claimed) {
      console.log(`[billing] ${sub.subscriptionId} period already claimed — skipping Arc charge`);
      return false;
    }

    const result = await renewFromAllowance(sub.onChainSubId);
    if (!result.success) throw new Error(result.failureReason ?? "PaymentFailed on-chain");

    const days = intervalDays[interval] ?? 30;
    const newPeriodStart = now;
    const newPeriodEnd = addDays(now, days);

    // Trial conversions are the FIRST payment — the contract escrows them for the
    // settlement window instead of pushing, so the payment stays "pending" until
    // settleDuePeriods() releases it.
    const escrowed = result.escrowed;
    const windowSecs = settlementWindowSeconds(sub.plan.settlementWindowHours);

    const [, renewalPayment] = await prisma.$transaction([
      prisma.subscription.update({
        where: { id: sub.id },
        data: {
          currentPeriodStart: newPeriodStart,
          currentPeriodEnd: newPeriodEnd,
          retryCount: 0,
          status: "active",
          ...(escrowed
            ? { escrowBalance: amount, settlementDeadline: addSeconds(now, windowSecs) }
            : {}),
        },
      }),
      prisma.payment.create({
        data: {
          paymentId: ids.payment(),
          merchantId: sub.merchantId,
          subscriptionId: sub.id,
          amount: amount,
          currency: sub.plan.currency,
          // An escrowed renewal is not yet a receipt — markSettled sends it.
          status: escrowed ? "pending" : "succeeded",
          type,
          isTestMode: sub.isTestMode,
          txHash: result.txHash,
          blockNumber: result.blockNumber,
          chain: "arc",
        },
      }),
    ]);

    // Escrowed renewals stay pending and get their receipt from markSettled;
    // the guard inside sendPaymentReceipt is what makes this call safe either way.
    void sendPaymentReceipt(renewalPayment.id);

    await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "subscription.renewed", {
      subscription_id: sub.subscriptionId,
      plan_id: sub.plan.planId,
      amount: Number(amount),
      currency: sub.plan.currency,
      tx_hash: result.txHash,
      block_number: Number(result.blockNumber),
      chain: "arc",
      current_period_end: newPeriodEnd.toISOString(),
    });

    if (!escrowed) {
      await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "payment.succeeded", {
        subscription_id: sub.subscriptionId,
        amount: Number(amount),
        currency: sub.plan.currency,
        tx_hash: result.txHash,
        block_number: Number(result.blockNumber),
        type,
      });
    }

    console.log(`[billing] Renewed ${sub.subscriptionId} tx=${result.txHash}${escrowed ? " (escrowed)" : ""}`);
    return true;
  } catch (e) {
    console.error(`[billing] renew failed for ${sub.subscriptionId}:`, e);

    // Release the period claim so a daily retry can re-charge this same period.
    // The on-chain nextBillingDate gate prevents an actual double Arc charge even
    // if the failure happened after the on-chain pull.
    if (claimed) await releaseClaim(sub.id, periodKey).catch(() => {});

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "past_due", retryCount: { increment: 1 } },
    });

    await prisma.payment.create({
      data: {
        paymentId: ids.payment(),
        merchantId: sub.merchantId,
        subscriptionId: sub.id,
        amount: amount,
        currency: sub.plan.currency,
        status: "failed",
        type,
        isTestMode: sub.isTestMode,
        failureReason: String(e),
        chain: "arc",
      },
    });

    await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "subscription.past_due", {
      subscription_id: sub.subscriptionId,
      plan_id: sub.plan.planId,
    });

    await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "payment.failed", {
      subscription_id: sub.subscriptionId,
      amount: Number(amount),
      reason: String(e),
    });

    return false;
  }
}

// ─── Failed-payment retry cycle (daily × 7, then cancel) ──────────────────────

export async function retryFailed() {
  console.log("[billing] retryFailed starting");

  const pastDue = await prisma.subscription.findMany({
    where: { status: "past_due" },
    include: { plan: true, merchant: true },
  });

  console.log(`[billing] ${pastDue.length} subscriptions to retry`);

  for (const sub of pastDue) {
    if (sub.retryCount >= MAX_RETRIES) {
      await cancelAfterMaxRetries(sub);
      continue;
    }

    const recovered = await renewSubscription(sub, "renewal");
    if (!recovered && sub.retryCount + 1 >= MAX_RETRIES) {
      await cancelAfterMaxRetries(sub);
    }
  }
}

async function cancelAfterMaxRetries(sub: SubWithRelations) {
  // Cancel on-chain too — returns any remaining escrow to the subscriber and
  // stops the contract from accepting further renewals.
  if (sub.onChainSubId) {
    try {
      await cancelOnChain(sub.onChainSubId);
    } catch (e) {
      console.error(`[billing] on-chain cancel failed for ${sub.subscriptionId}:`, e);
    }
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: "Payment failed after maximum retries",
      escrowBalance: 0n,
      settlementDeadline: null,
    },
  });

  await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "subscription.cancelled", {
    subscription_id: sub.subscriptionId,
    cancel_reason: "Payment failed after maximum retries",
  });

  console.log(`[billing] Cancelled ${sub.subscriptionId} after ${MAX_RETRIES} retries`);
}

// ─── Trial conversions ────────────────────────────────────────────────────────
// First renewFromAllowance() after trial end. The contract escrows this first
// payment for the settlement window (decision 1: escrow covers trial conversions).

export async function transitionTrials() {
  const now = new Date();
  console.log("[billing] transitionTrials starting");

  const expiredTrials = await prisma.subscription.findMany({
    where: { status: "trialing", trialEnd: { lte: now } },
    include: { plan: true, merchant: true },
  });

  console.log(`[billing] ${expiredTrials.length} trials to convert`);

  for (const sub of expiredTrials) {
    const converted = await renewSubscription(sub, "initial");
    if (converted) {
      console.log(`[billing] Trial converted to active: ${sub.subscriptionId}`);
    }
  }
}

// ─── Webhook retry queue ──────────────────────────────────────────────────────

export async function retryWebhooks() {
  const now = new Date();
  const pending = await prisma.webhookDelivery.findMany({
    where: { status: "failed", attempts: { lt: 5 }, nextRetryAt: { lte: now } },
    include: { endpoint: true },
    take: 100,
  });

  for (const delivery of pending) {
    const body = JSON.stringify(delivery.payload);
    const signature = signWebhook(body, delivery.endpoint.secret);

    try {
      // The retry queue dials the same URL the first delivery did, hours or
      // days later — which is exactly the window a DNS rebind needs. Re-check.
      await assertDeliverableUrl(delivery.endpoint.url);

      const fetchRes = await fetch(delivery.endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sweep-Signature": signature,
          "X-Sweep-Event": delivery.eventType,
          "X-Sweep-Event-Id": delivery.eventId,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: fetchRes.ok ? "delivered" : "failed",
          attempts: { increment: 1 },
          lastAttemptAt: now,
          responseStatus: fetchRes.status,
          nextRetryAt: fetchRes.ok ? null : getNextRetryAt(delivery.attempts + 1),
        },
      });
    } catch {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { attempts: { increment: 1 }, lastAttemptAt: now, nextRetryAt: getNextRetryAt(delivery.attempts + 1) },
      });
    }
  }
}
