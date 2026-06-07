import { NextRequest } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, created, err, notFound, validationError } from "@/lib/api/response";
import { ids } from "@/lib/ids";

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

export async function POST(req: NextRequest) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid JSON body", 400);

  const parsed = createWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
      )
    );
  }

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      endpointId: ids.webhook(),
      merchantId: auth.merchant.id,
      url: parsed.data.url,
      events: parsed.data.events,
      secret: randomBytes(32).toString("hex"),
    },
  });

  return created({
    id: endpoint.endpointId,
    url: endpoint.url,
    events: endpoint.events,
    secret: endpoint.secret, // returned once at creation; store it safely
    created_at: endpoint.createdAt.toISOString(),
  });
}

export async function GET(req: NextRequest) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { merchantId: auth.merchant.id, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  return ok({
    data: endpoints.map((e) => ({
      id: e.endpointId,
      url: e.url,
      events: e.events,
      created_at: e.createdAt.toISOString(),
    })),
  });
}
