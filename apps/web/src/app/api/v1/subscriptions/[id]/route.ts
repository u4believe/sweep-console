import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err, notFound } from "@/lib/api/response";
import { serializeSubscription } from "../route";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { id } = await params;
  const sub = await prisma.subscription.findFirst({
    where: { subscriptionId: id, merchantId: auth.merchant.id },
    include: { plan: true },
  });
  if (!sub) return notFound("Subscription");

  return ok(serializeSubscription(sub));
}
