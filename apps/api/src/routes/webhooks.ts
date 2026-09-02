import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";
import { verifyApiKey, type AuthedRequest } from "../middleware/auth";
import { ok, created, err, validationError } from "../lib/response";
import { signWebhook } from "../lib/webhooks/sign";
import { ids } from "../lib/ids";
import { WEBHOOK_EVENTS } from "../lib/webhooks/events";
import { assertDeliverableUrl, WebhookUrlError } from "../lib/webhooks/url-guard";

export const webhooksRouter = Router();

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

webhooksRouter.post("/", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const parsed = createWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }

  // Same guard as the portal route. Without it this endpoint — reachable with
  // nothing but an API key — is a way around it.
  try {
    await assertDeliverableUrl(parsed.data.url);
  } catch (e) {
    if (e instanceof WebhookUrlError) return validationError(res, { url: e.message });
    throw e;
  }

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      endpointId: ids.webhook(),
      merchantId: merchant.id,
      url: parsed.data.url,
      events: parsed.data.events,
      // whsec_-prefixed, matching the portal — the two used to differ, so the
      // same merchant got two shapes of secret depending on how they registered.
      secret: `whsec_${randomBytes(24).toString("hex")}`,
    },
  });

  return created(res, {
    id: endpoint.endpointId,
    url: endpoint.url,
    events: endpoint.events,
    secret: endpoint.secret,
    created_at: endpoint.createdAt.toISOString(),
  });
});

webhooksRouter.get("/", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { merchantId: merchant.id, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  return ok(res, {
    data: endpoints.map((e) => ({
      id: e.endpointId,
      url: e.url,
      events: e.events,
      created_at: e.createdAt.toISOString(),
    })),
  });
});

webhooksRouter.delete("/:id", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { endpointId: req.params.id as string, merchantId: merchant.id },
  });
  if (!endpoint) return err(res, "Webhook endpoint not found", 404, "not_found");

  await prisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { isActive: false },
  });

  return res.status(204).send();
});

webhooksRouter.post("/:id/replay/:event_id", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { endpointId: req.params.id as string, merchantId: merchant.id },
  });
  if (!endpoint) return err(res, "Webhook endpoint not found", 404, "not_found");

  const delivery = await prisma.webhookDelivery.findFirst({
    where: { eventId: req.params.event_id as string, endpointId: endpoint.id },
  });
  if (!delivery) return err(res, "Webhook event not found", 404, "not_found");

  const body = JSON.stringify(delivery.payload);
  const signature = signWebhook(body, endpoint.secret);

  // Replay is the sharpest edge on this surface: the caller triggers the request
  // on demand AND reads response_status straight back, so an unchecked one is a
  // synchronous port scanner. Re-validate here — the check at registration says
  // nothing about where the name points now.
  try {
    await assertDeliverableUrl(endpoint.url);
  } catch (e) {
    if (e instanceof WebhookUrlError) return validationError(res, { url: e.message });
    throw e;
  }

  let responseStatus: number | undefined;
  let status = "failed";

  try {
    const fetchRes = await fetch(endpoint.url, {
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

    responseStatus = fetchRes.status;
    status = fetchRes.ok ? "delivered" : "failed";
  } catch {
    // delivery failure recorded below
  }

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: { status, attempts: { increment: 1 }, lastAttemptAt: new Date(), responseStatus },
  });

  return ok(res, { event_id: delivery.eventId, status, response_status: responseStatus });
});
