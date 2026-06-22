import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";
import { verifyApiKey, type AuthedRequest } from "../middleware/auth";
import { ok, created, err, validationError } from "../lib/response";
import { signWebhook } from "../lib/webhooks/sign";
import { ids } from "../lib/ids";

export const webhooksRouter = Router();

const VALID_EVENTS = [
  "checkout.session.completed",
  "subscription.created",
  "subscription.renewed",
  "subscription.cancelled",
  "subscription.past_due",
  "subscription.trial_started",
  "subscription.trial_ending",
  "payment.succeeded",
  "payment.failed",
  "passport.activated",
] as const;

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(VALID_EVENTS)).min(1),
});

webhooksRouter.post("/", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const parsed = createWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      endpointId: ids.webhook(),
      merchantId: merchant.id,
      url: parsed.data.url,
      events: parsed.data.events,
      secret: randomBytes(32).toString("hex"),
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
