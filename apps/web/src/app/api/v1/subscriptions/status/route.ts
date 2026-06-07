import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err, notFound } from "@/lib/api/response";
import { serializeSubscription } from "../route";

// GET /v1/subscriptions/status?merchant_id=A1B2&external_ref=user_123
export async function GET(req: NextRequest) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { searchParams } = new URL(req.url);
  const externalRef = searchParams.get("external_ref");

  if (!externalRef) return err("external_ref query parameter is required", 400);

  const sub = await prisma.subscription.findFirst({
    where: {
      merchantId: auth.merchant.id,
      externalRef,
      status: { in: ["active", "trialing", "past_due"] },
    },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });

  if (!sub) return notFound("Active subscription");

  return ok(serializeSubscription(sub));
}
