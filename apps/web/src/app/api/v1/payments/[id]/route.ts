import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, err, notFound } from "@/lib/api/response";
import { serializePayment } from "../route";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { id } = await params;
  const payment = await prisma.payment.findFirst({
    where: { paymentId: id, merchantId: auth.merchant.id },
  });
  if (!payment) return notFound("Payment");

  return ok(serializePayment(payment));
}
