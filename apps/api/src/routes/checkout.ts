import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { verifyApiKey, type AuthedRequest } from "../middleware/auth";
import { created, ok, err, validationError } from "../lib/response";
import { createCheckoutSession, SessionCreationError } from "../lib/checkout/session";

export const checkoutRouter = Router();

const createSessionSchema = z.object({
  plan_id: z.string(),
  external_ref: z.string().min(1).max(255),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
  metadata: z.record(z.unknown()).optional(),
});

function serializeSession(session: {
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

checkoutRouter.post("/sessions", verifyApiKey, async (req, res) => {
  const { merchant, isTestMode } = req as AuthedRequest;
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(res, Object.fromEntries(
      Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
    ));
  }

  const { plan_id, external_ref, success_url, cancel_url, metadata } = parsed.data;

  const plan = await prisma.plan.findFirst({
    where: { planId: plan_id, merchantId: merchant.id, archived: false },
  });
  if (!plan) return err(res, "Plan not found", 404, "not_found");

  try {
    const { session, checkoutUrl } = await createCheckoutSession({
      merchantId: merchant.id,
      plan,
      externalRef: external_ref,
      successUrl: success_url,
      cancelUrl: cancel_url,
      metadata: (metadata ?? {}) as Prisma.InputJsonValue,
      isTestMode,
    });

    return created(res, {
      session_id: session.sessionId,
      checkout_url: checkoutUrl,
      session_token: session.sessionToken,
      plan: {
        name: plan.name,
        amount: Number(plan.amount),
        currency: plan.currency,
        interval: plan.interval,
      },
      expires_at: session.expiresAt.toISOString(),
      status: session.status,
    });
  } catch (e) {
    if (e instanceof SessionCreationError) return err(res, e.message, e.httpStatus, e.code);
    console.error("[checkout/sessions]", e);
    return err(res, "Failed to create checkout session", 500);
  }
});

checkoutRouter.get("/sessions/:id", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const session = await prisma.checkoutSession.findFirst({
    where: { sessionId: req.params.id as string, merchantId: merchant.id },
    include: { plan: true },
  });
  if (!session) return err(res, "Checkout session not found", 404, "not_found");
  return ok(res, serializeSession(session));
});

checkoutRouter.post("/sessions/:id/expire", verifyApiKey, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const session = await prisma.checkoutSession.findFirst({
    where: { sessionId: req.params.id as string, merchantId: merchant.id },
  });
  if (!session) return err(res, "Checkout session not found", 404, "not_found");
  if (session.status !== "open") return err(res, `Session is already ${session.status}`, 409);

  const updated = await prisma.checkoutSession.update({
    where: { id: session.id },
    data: { status: "expired" },
  });

  return ok(res, { id: updated.sessionId, status: updated.status });
});
