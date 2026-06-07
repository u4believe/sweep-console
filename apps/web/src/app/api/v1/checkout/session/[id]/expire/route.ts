import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err, notFound } from "@/lib/api/response";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { id } = await params;
  const session = await prisma.checkoutSession.findFirst({
    where: { sessionId: id, merchantId: auth.merchant.id },
  });
  if (!session) return notFound("Checkout session");

  if (session.status !== "open") {
    return err(`Session is already ${session.status}`, 409);
  }

  const updated = await prisma.checkoutSession.update({
    where: { id: session.id },
    data: { status: "expired" },
  });

  return ok({ id: updated.sessionId, status: updated.status });
}
