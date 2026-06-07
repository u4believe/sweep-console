import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { noContent, err, notFound } from "@/lib/api/response";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { id } = await params;
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { endpointId: id, merchantId: auth.merchant.id },
  });
  if (!endpoint) return notFound("Webhook endpoint");

  await prisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { isActive: false },
  });

  return noContent();
}
