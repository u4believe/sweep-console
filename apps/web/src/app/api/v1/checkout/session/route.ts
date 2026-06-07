import { NextRequest } from "next/server";
import { z } from "zod";
import { addHours } from "date-fns";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { created, err, notFound, validationError } from "@/lib/api/response";
import { ids } from "@/lib/ids";

const createSessionSchema = z.object({
  plan_id: z.string(),
  external_ref: z.string().min(1).max(255),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
  metadata: z.record(z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid JSON body", 400);

  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
      )
    );
  }

  const { plan_id, external_ref, success_url, cancel_url, metadata } = parsed.data;

  const plan = await prisma.plan.findFirst({
    where: { planId: plan_id, merchantId: auth.merchant.id, archived: false },
  });
  if (!plan) return notFound("Plan");

  const sessionId = ids.session(!auth.isTestMode);
  const sessionToken = ids.sessionToken();
  const expiresAt = addHours(new Date(), 24);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const session = await prisma.checkoutSession.create({
    data: {
      sessionId,
      merchantId: auth.merchant.id,
      planId: plan.id,
      externalRef: external_ref,
      successUrl: success_url.replace("{SESSION_ID}", sessionId),
      cancelUrl: cancel_url,
      metadata: metadata ?? {},
      sessionToken,
      isTestMode: auth.isTestMode,
      expiresAt,
    },
  });

  return created({
    session_id: session.sessionId,
    checkout_url: `${appUrl}/checkout/${session.sessionId}`,
    session_token: session.sessionToken,
    plan: {
      name: plan.name,
      amount: Number(plan.amount),
      currency: plan.currency,
      interval: plan.interval,
    },
    expires_at: expiresAt.toISOString(),
    status: session.status,
  });
}
