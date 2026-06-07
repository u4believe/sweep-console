import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err, notFound } from "@/lib/api/response";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { id } = await params;
  const session = await prisma.checkoutSession.findFirst({
    where: { sessionId: id, merchantId: auth.merchant.id },
    include: { plan: true },
  });
  if (!session) return notFound("Checkout session");

  return ok(serializeSession(session));
}

export function serializeSession(session: {
  sessionId: string; status: string; externalRef: string;
  successUrl: string; cancelUrl: string; metadata: unknown;
  isTestMode: boolean; expiresAt: Date; createdAt: Date;
  subscriptionId: string | null;
  plan: { name: string; amount: bigint; currency: string; interval: string };
}) {
  return {
    id: session.sessionId,
    status: session.status,
    external_ref: session.externalRef,
    success_url: session.successUrl,
    cancel_url: session.cancelUrl,
    metadata: session.metadata,
    test_mode: session.isTestMode,
    plan: {
      name: session.plan.name,
      amount: Number(session.plan.amount),
      currency: session.plan.currency,
      interval: session.plan.interval,
    },
    subscription_id: session.subscriptionId,
    expires_at: session.expiresAt.toISOString(),
    created_at: session.createdAt.toISOString(),
  };
}
