import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err, notFound } from "@/lib/api/response";
import { signWebhook } from "@/lib/webhooks/sign";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; event_id: string }> }
) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { id, event_id } = await params;

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { endpointId: id, merchantId: auth.merchant.id },
  });
  if (!endpoint) return notFound("Webhook endpoint");

  const delivery = await prisma.webhookDelivery.findFirst({
    where: { eventId: event_id, endpointId: endpoint.id },
  });
  if (!delivery) return notFound("Webhook event");

  const body = JSON.stringify(delivery.payload);
  const signature = signWebhook(body, endpoint.secret);

  let responseStatus: number | undefined;
  let status = "failed";

  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sweep-Signature": signature,
        "X-Sweep-Event": delivery.eventType,
        "X-Sweep-Event-Id": delivery.eventId,
        "X-Sweep-Replay": "true",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    responseStatus = res.status;
    status = res.ok ? "delivered" : "failed";
  } catch {
    // delivery failure recorded below
  }

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status,
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      responseStatus,
    },
  });

  return ok({ event_id: delivery.eventId, status, response_status: responseStatus });
}
