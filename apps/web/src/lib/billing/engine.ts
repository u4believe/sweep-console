import { addDays } from "date-fns";
import { prisma } from "@/lib/prisma";
import { renewOnChain } from "@/lib/chain/subscription";
import { fireWebhook } from "@/lib/webhooks/delivery";
import { ids } from "@/lib/ids";

const MAX_RETRIES = 7;

// ─── Job: processRenewals ─────────────────────────────────────────────────────
// Runs daily at 2 AM. Finds active subscriptions due for billing and charges them.

export async function processRenewals() {
  const now = new Date();
  console.log(`[billing] processRenewals starting at ${now.toISOString()}`);

  const due = await prisma.subscription.findMany({
    where: {
      status: "active",
      currentPeriodEnd: { lte: now },
    },
    include: { plan: true, merchant: true },
  });

  console.log(`[billing] ${due.length} subscriptions due for renewal`);

  for (const sub of due) {
    try {
      const { txHash, blockNumber } = await renewOnChain(
        sub.onChainSubId as `0x${string}`,
        sub.isTestMode
      );

      const intervalDays = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
      const days = intervalDays[sub.plan.interval as keyof typeof intervalDays] ?? 30;
      const newPeriodStart = now;
      const newPeriodEnd = addDays(now, days);

      await prisma.$transaction([
        prisma.subscription.update({
          where: { id: sub.id },
          data: {
            currentPeriodStart: newPeriodStart,
            currentPeriodEnd: newPeriodEnd,
            retryCount: 0,
            status: "active",
          },
        }),
        prisma.payment.create({
          data: {
            paymentId: ids.payment(),
            merchantId: sub.merchantId,
            subscriptionId: sub.id,
            amount: sub.plan.amount,
            currency: sub.plan.currency,
            status: "succeeded",
            type: "renewal",
            isTestMode: sub.isTestMode,
            txHash,
            blockNumber,
            chain: "arc",
          },
        }),
      ]);

      await fireWebhook(
        sub.merchantId,
        sub.externalRef,
        sub.merchant.merchantId,
        "subscription.renewed",
        {
          subscription_id: sub.subscriptionId,
          plan_id: sub.plan.planId,
          amount: Number(sub.plan.amount),
          currency: sub.plan.currency,
          tx_hash: txHash,
          block_number: Number(blockNumber),
          chain: "arc",
          current_period_end: newPeriodEnd.toISOString(),
        }
      );

      await fireWebhook(
        sub.merchantId,
        sub.externalRef,
        sub.merchant.merchantId,
        "payment.succeeded",
        {
          subscription_id: sub.subscriptionId,
          amount: Number(sub.plan.amount),
          currency: sub.plan.currency,
          tx_hash: txHash,
          type: "renewal",
        }
      );

      console.log(`[billing] Renewed ${sub.subscriptionId} tx=${txHash}`);
    } catch (err) {
      console.error(`[billing] renew failed for ${sub.subscriptionId}:`, err);

      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: "past_due", retryCount: { increment: 1 } },
      });

      await prisma.payment.create({
        data: {
          paymentId: ids.payment(),
          merchantId: sub.merchantId,
          subscriptionId: sub.id,
          amount: sub.plan.amount,
          currency: sub.plan.currency,
          status: "failed",
          type: "renewal",
          isTestMode: sub.isTestMode,
          failureReason: String(err),
          chain: "arc",
        },
      });

      await fireWebhook(
        sub.merchantId,
        sub.externalRef,
        sub.merchant.merchantId,
        "subscription.past_due",
        { subscription_id: sub.subscriptionId, plan_id: sub.plan.planId }
      );

      await fireWebhook(
        sub.merchantId,
        sub.externalRef,
        sub.merchant.merchantId,
        "payment.failed",
        {
          subscription_id: sub.subscriptionId,
          amount: Number(sub.plan.amount),
          reason: String(err),
        }
      );
    }
  }
}

// ─── Job: retryFailed ─────────────────────────────────────────────────────────
// Runs daily at 6 AM. Retries past_due subscriptions. Cancels after MAX_RETRIES.

export async function retryFailed() {
  console.log("[billing] retryFailed starting");

  const pastDue = await prisma.subscription.findMany({
    where: { status: "past_due", retryCount: { lt: MAX_RETRIES } },
    include: { plan: true, merchant: true },
  });

  console.log(`[billing] ${pastDue.length} subscriptions to retry`);

  for (const sub of pastDue) {
    try {
      const { txHash, blockNumber } = await renewOnChain(
        sub.onChainSubId as `0x${string}`,
        sub.isTestMode
      );

      const intervalDays = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
      const days = intervalDays[sub.plan.interval as keyof typeof intervalDays] ?? 30;
      const newPeriodEnd = addDays(new Date(), days);

      await prisma.$transaction([
        prisma.subscription.update({
          where: { id: sub.id },
          data: {
            status: "active",
            retryCount: 0,
            currentPeriodStart: new Date(),
            currentPeriodEnd: newPeriodEnd,
          },
        }),
        prisma.payment.create({
          data: {
            paymentId: ids.payment(),
            merchantId: sub.merchantId,
            subscriptionId: sub.id,
            amount: sub.plan.amount,
            currency: sub.plan.currency,
            status: "succeeded",
            type: "renewal",
            isTestMode: sub.isTestMode,
            txHash,
            blockNumber,
            chain: "arc",
          },
        }),
      ]);

      await fireWebhook(
        sub.merchantId,
        sub.externalRef,
        sub.merchant.merchantId,
        "subscription.renewed",
        {
          subscription_id: sub.subscriptionId,
          plan_id: sub.plan.planId,
          amount: Number(sub.plan.amount),
          currency: sub.plan.currency,
          tx_hash: txHash,
        }
      );

      console.log(`[billing] Retry succeeded ${sub.subscriptionId}`);
    } catch {
      const newRetryCount = sub.retryCount + 1;

      if (newRetryCount >= MAX_RETRIES) {
        await prisma.subscription.update({
          where: { id: sub.id },
          data: {
            status: "cancelled",
            cancelledAt: new Date(),
            cancelReason: "Payment failed after maximum retries",
          },
        });

        await fireWebhook(
          sub.merchantId,
          sub.externalRef,
          sub.merchant.merchantId,
          "subscription.cancelled",
          {
            subscription_id: sub.subscriptionId,
            cancel_reason: "Payment failed after maximum retries",
          }
        );

        console.log(`[billing] Cancelled ${sub.subscriptionId} after ${MAX_RETRIES} retries`);
      } else {
        await prisma.subscription.update({
          where: { id: sub.id },
          data: { retryCount: newRetryCount },
        });
        console.log(`[billing] Retry ${newRetryCount}/${MAX_RETRIES} failed for ${sub.subscriptionId}`);
      }
    }
  }
}

// ─── Job: transitionTrials ────────────────────────────────────────────────────
// Runs daily at 1 AM. Converts trialing subscriptions whose trial has ended.

export async function transitionTrials() {
  const now = new Date();
  console.log("[billing] transitionTrials starting");

  const expiredTrials = await prisma.subscription.findMany({
    where: {
      status: "trialing",
      trialEnd: { lte: now },
    },
    include: { plan: true, merchant: true },
  });

  console.log(`[billing] ${expiredTrials.length} trials to convert`);

  for (const sub of expiredTrials) {
    // Send 3-day warning first (fired separately by a warning job, but here we check)
    try {
      const { txHash, blockNumber } = await renewOnChain(
        sub.onChainSubId as `0x${string}`,
        sub.isTestMode
      );

      const intervalDays = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
      const days = intervalDays[sub.plan.interval as keyof typeof intervalDays] ?? 30;
      const periodEnd = addDays(now, days);

      await prisma.$transaction([
        prisma.subscription.update({
          where: { id: sub.id },
          data: {
            status: "active",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          },
        }),
        prisma.payment.create({
          data: {
            paymentId: ids.payment(),
            merchantId: sub.merchantId,
            subscriptionId: sub.id,
            amount: sub.plan.amount,
            currency: sub.plan.currency,
            status: "succeeded",
            type: "initial",
            isTestMode: sub.isTestMode,
            txHash,
            blockNumber,
            chain: "arc",
          },
        }),
      ]);

      await fireWebhook(
        sub.merchantId,
        sub.externalRef,
        sub.merchant.merchantId,
        "subscription.renewed",
        {
          subscription_id: sub.subscriptionId,
          plan_id: sub.plan.planId,
          tx_hash: txHash,
          current_period_end: periodEnd.toISOString(),
        }
      );

      console.log(`[billing] Trial converted to active: ${sub.subscriptionId}`);
    } catch {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: "past_due", retryCount: 1 },
      });

      await fireWebhook(
        sub.merchantId,
        sub.externalRef,
        sub.merchant.merchantId,
        "subscription.past_due",
        { subscription_id: sub.subscriptionId }
      );
    }
  }
}

// ─── Job: retryWebhooks ───────────────────────────────────────────────────────
// Retries failed webhook deliveries with exponential backoff.

export async function retryWebhooks() {
  const now = new Date();
  const pending = await prisma.webhookDelivery.findMany({
    where: {
      status: "failed",
      attempts: { lt: 5 },
      nextRetryAt: { lte: now },
    },
    include: { endpoint: true },
    take: 100,
  });

  for (const delivery of pending) {
    const { signWebhook } = await import("@/lib/webhooks/sign");
    const body = JSON.stringify(delivery.payload);
    const signature = signWebhook(body, delivery.endpoint.secret);

    try {
      const res = await fetch(delivery.endpoint.url, {
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

      const { getNextRetryAt } = await import("@/lib/webhooks/delivery");
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: res.ok ? "delivered" : "failed",
          attempts: { increment: 1 },
          lastAttemptAt: now,
          responseStatus: res.status,
          nextRetryAt: res.ok ? null : getNextRetryAt(delivery.attempts + 1),
        },
      });
    } catch {
      const { getNextRetryAt } = await import("@/lib/webhooks/delivery");
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts: { increment: 1 },
          lastAttemptAt: now,
          nextRetryAt: getNextRetryAt(delivery.attempts + 1),
        },
      });
    }
  }
}
