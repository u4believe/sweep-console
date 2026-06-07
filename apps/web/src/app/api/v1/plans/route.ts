import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyApiKey } from "@/lib/api/auth";
import { ok, created, err, validationError } from "@/lib/api/response";
import { ids } from "@/lib/ids";

const createPlanSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  amount: z.number().int().positive(), // USDC smallest unit
  currency: z.enum(["USDC", "EURC"]).default("USDC"),
  interval: z.enum(["daily", "weekly", "monthly", "yearly"]),
  trial_days: z.number().int().min(0).max(365).default(0),
  metadata: z.record(z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid JSON body", 400);

  const parsed = createPlanSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
      )
    );
  }

  const { name, description, amount, currency, interval, trial_days, metadata } = parsed.data;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20);

  const plan = await prisma.plan.create({
    data: {
      planId: ids.plan(slug),
      merchantId: auth.merchant.id,
      name,
      description,
      amount: BigInt(amount),
      currency,
      interval,
      trialDays: trial_days,
      metadata: metadata ?? {},
    },
  });

  return created(serializePlan(plan));
}

export async function GET(req: NextRequest) {
  const auth = await verifyApiKey(req);
  if (!auth.ok) return err(auth.error, auth.status);

  const plans = await prisma.plan.findMany({
    where: { merchantId: auth.merchant.id, archived: false },
    orderBy: { createdAt: "desc" },
  });

  return ok({ data: plans.map(serializePlan), count: plans.length });
}

export function serializePlan(plan: {
  planId: string; name: string; description: string | null;
  amount: bigint; currency: string; interval: string; trialDays: number;
  archived: boolean; metadata: unknown; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: plan.planId,
    name: plan.name,
    description: plan.description,
    amount: Number(plan.amount),
    currency: plan.currency,
    interval: plan.interval,
    trial_days: plan.trialDays,
    archived: plan.archived,
    metadata: plan.metadata,
    created_at: plan.createdAt.toISOString(),
    updated_at: plan.updatedAt.toISOString(),
  };
}
