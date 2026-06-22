import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { verifyApiKey, type AuthedRequest } from "../middleware/auth";
import { ok, created, err, validationError } from "../lib/response";
import { ids } from "../lib/ids";
import { closePlanSubscriptions, findSubsToClose } from "../lib/plan-lifecycle";

export const plansRouter = Router();

const createPlanSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  amount: z.number().int().positive(),
  currency: z.enum(["USDC", "EURC"]).default("USDC"),
  interval: z.enum(["daily", "weekly", "monthly", "yearly"]),
  trial_days: z.number().int().min(0).max(365).default(0),
  // Escrow hold on the plan's first payments; defaults to the platform-wide
  // SETTLEMENT_WINDOW_HOURS when omitted (the window is the only refund path)
  settlement_window_hours: z.number().int().min(1).max(720).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updatePlanSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});

function serializePlan(plan: {
  planId: string; name: string; description: string | null;
  amount: bigint; currency: string; interval: string; trialDays: number;
  settlementWindowHours: number | null;
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
    settlement_window_hours: plan.settlementWindowHours,
    archived: plan.archived,
    metadata: plan.metadata,
    created_at: plan.createdAt.toISOString(),
    updated_at: plan.updatedAt.toISOString(),
  };
}

plansRouter.post("/", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const parsed = createPlanSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }

  // One active plan per merchant: a creator must delete their existing plan before
  // creating a new one (tiers cover multiple price points within the one plan).
  const activePlan = await prisma.plan.findFirst({
    where: { merchantId: merchant.id, archived: false },
    select: { planId: true },
  });
  if (activePlan) {
    return err(
      res,
      "You already have an active plan. Delete it before creating a new one.",
      409,
      "plan_exists"
    );
  }

  const { name, description, amount, currency, interval, trial_days, settlement_window_hours, metadata } = parsed.data;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20);

  const plan = await prisma.plan.create({
    data: {
      planId: ids.plan(slug),
      merchantId: merchant.id,
      name,
      description,
      amount: BigInt(amount),
      currency,
      interval,
      trialDays: trial_days,
      settlementWindowHours: settlement_window_hours ?? null,
      metadata: (metadata ?? {}) as Prisma.InputJsonValue,
    },
  });

  return created(res, serializePlan(plan));
});

plansRouter.get("/", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const plans = await prisma.plan.findMany({
    where: { merchantId: merchant.id, archived: false },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, { data: plans.map(serializePlan), count: plans.length });
});

// Single plan, INCLUDING archived (deleted) plans — so historical/closed plan
// details remain accessible for data fetching.
plansRouter.get("/:id", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const plan = await prisma.plan.findFirst({
    where: { planId: req.params.id as string, merchantId: merchant.id },
  });
  if (!plan) return err(res, "Plan not found", 404, "not_found");
  return ok(res, serializePlan(plan));
});

plansRouter.patch("/:id", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const plan = await prisma.plan.findFirst({
    where: { planId: req.params.id as string, merchantId: merchant.id },
  });
  if (!plan) return err(res, "Plan not found", 404, "not_found");

  const parsed = updatePlanSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }

  const updated = await prisma.plan.update({
    where: { id: plan.id },
    data: {
      ...(parsed.data.name && { name: parsed.data.name }),
      ...(parsed.data.description !== undefined && { description: parsed.data.description }),
      ...(parsed.data.metadata && { metadata: parsed.data.metadata as Prisma.InputJsonValue }),
    },
  });

  return ok(res, serializePlan(updated));
});

plansRouter.delete("/:id", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const plan = await prisma.plan.findFirst({
    where: { planId: req.params.id as string, merchantId: merchant.id },
  });
  if (!plan) return err(res, "Plan not found", 404, "not_found");
  if (plan.archived) return ok(res, { archived: true, cancelling: 0 });

  // Soft-delete immediately: blocks new checkouts; the row stays for data fetching.
  await prisma.plan.update({ where: { id: plan.id }, data: { archived: true } });

  // Self-enforce, detached: cancel on-chain (refunds any escrow), mark cancelled,
  // and send one trust email. Respond immediately with the count.
  const subs = await findSubsToClose(plan.id);
  void closePlanSubscriptions(
    { name: plan.name, currency: plan.currency, merchantName: merchant.name, merchantPublicId: merchant.merchantId },
    subs
  ).catch((e) => console.error("[plans/delete] closing subscriptions failed:", e));

  return ok(res, { archived: true, cancelling: subs.length });
});
