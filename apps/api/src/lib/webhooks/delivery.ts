import { prisma } from "../prisma";
import { signWebhook } from "./sign";
import { ids } from "../ids";

export type WebhookEventType =
  | "checkout.session.completed"
  | "subscription.created"
  | "subscription.renewed"
  | "subscription.cancelled"
  | "subscription.past_due"
  | "subscription.trial_started"
  | "subscription.trial_ending"
  | "payment.succeeded"
  | "payment.failed"
  | "payment.refunded"
  | "passport.activated";

interface WebhookPayload {
  event_id: string;
  event_type: WebhookEventType;
  created_at: string;
  merchant_id: string;
  external_ref: string;
  data: Record<string, unknown>;
}

export async function fireWebhook(
  merchantId: string,
  externalRef: string,
  merchantPublicId: string,
  eventType: WebhookEventType,
  data: Record<string, unknown>
) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { merchantId, isActive: true, events: { has: eventType } },
  });

  if (endpoints.length === 0) return;

  const eventId = ids.event();
  const payload: WebhookPayload = {
    event_id: eventId,
    event_type: eventType,
    created_at: new Date().toISOString(),
    merchant_id: merchantPublicId,
    external_ref: externalRef,
    data,
  };

  await Promise.allSettled(
    endpoints.map((endpoint) => deliverToEndpoint(endpoint, payload))
  );
}

async function deliverToEndpoint(
  endpoint: { id: string; url: string; secret: string },
  payload: WebhookPayload
) {
  const body = JSON.stringify(payload);
  const signature = signWebhook(body, endpoint.secret);

  const delivery = await prisma.webhookDelivery.create({
    data: {
      eventId: payload.event_id,
      endpointId: endpoint.id,
      eventType: payload.event_type,
      payload: payload as object,
      status: "pending",
      attempts: 0,
    },
  });

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sweep-Signature": signature,
        "X-Sweep-Event": payload.event_type,
        "X-Sweep-Event-Id": payload.event_id,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: res.ok ? "delivered" : "failed",
        attempts: 1,
        lastAttemptAt: new Date(),
        responseStatus: res.status,
        nextRetryAt: res.ok ? null : getNextRetryAt(1),
      },
    });
  } catch (e) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "failed",
        attempts: 1,
        lastAttemptAt: new Date(),
        responseBody: String(e),
        nextRetryAt: getNextRetryAt(1),
      },
    });
  }
}

export function getNextRetryAt(attempt: number): Date {
  const delaysMinutes = [5, 30, 120, 300, 600];
  const delayMs = (delaysMinutes[attempt - 1] ?? 600) * 60 * 1000;
  return new Date(Date.now() + delayMs);
}
