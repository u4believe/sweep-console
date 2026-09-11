import { addDays, addSeconds } from "date-fns";
import { prisma } from "../lib/prisma";
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

// ─── Trial conversions ────────────────────────────────────────────────────────
// A trial ends by becoming DUE, not by being charged here.
//
// It used to convert with an allowance pull and an escrowed first payment.
// There is no allowance and no escrow now, so this flips the status and leaves
// currentPeriodEnd at the trial's end — which is in the past, so the delegated
// renewal pass picks it up on its next run and collects it the same way it
// collects every other due period. One charging mechanism, not two.

export async function transitionTrials() {
  const now = new Date();
  console.log("[billing] transitionTrials starting");

  const expiredTrials = await prisma.subscription.findMany({
    where: { status: "trialing", trialEnd: { lte: now } },
    include: { plan: true, merchant: true },
  });

  console.log(`[billing] ${expiredTrials.length} trials to convert`);

  for (const sub of expiredTrials) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "active" },
    });
    console.log(`[billing] trial ended for ${sub.subscriptionId} — now due, the renewal pass will collect it`);
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
