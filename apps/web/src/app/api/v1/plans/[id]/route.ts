import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, noContent, err, notFound, validationError } from "@/lib/api/response";
import { serializePlan } from "../route";

const updatePlanSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
  // amount and interval are immutable — existing subscriptions depend on them
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { id } = await params;
  const plan = await prisma.plan.findFirst({
    where: { planId: id, merchantId: auth.merchant.id },
  });
  if (!plan) return notFound("Plan");

  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid JSON body", 400);

  const parsed = updatePlanSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
      )
    );
  }

  const updated = await prisma.plan.update({
    where: { id: plan.id },
    data: {
      ...(parsed.data.name && { name: parsed.data.name }),
      ...(parsed.data.description !== undefined && { description: parsed.data.description }),
      ...(parsed.data.metadata && { metadata: parsed.data.metadata }),
    },
  });

  return ok(serializePlan(updated));
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const { id } = await params;
  const plan = await prisma.plan.findFirst({
    where: { planId: id, merchantId: auth.merchant.id },
  });
  if (!plan) return notFound("Plan");

  // Soft-delete: existing subscriptions continue billing against the archived plan
  await prisma.plan.update({
    where: { id: plan.id },
    data: { archived: true },
  });

  return noContent();
}
