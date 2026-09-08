// /v1/mandates — the external rail's authorization resource.
//
// A mandate is a subscriber's signed, capped permission for ONE merchant, and it
// is what a charge names. It cannot be created server-to-server: the permission
// is a wallet signature, so POST here mints a "pending" row and returns a hosted
// URL for the subscriber to open. The same redirect dance checkout already does,
// and the same one GoCardless uses.
//
// What the subscriber signs produces one RenewalDelegation per chain — the
// mandate's GRANTS. Those are not linked to the Mandate row yet (the FK lands in
// the contract step), which is why revoke below can only close the authorization
// and not yet the grants underneath it. Nothing is authorizable until the
// authorization page ships, so today that gap is theoretical rather than live.

import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { addHours } from "date-fns";
import { prisma } from "../lib/prisma";
import { ids } from "../lib/ids";
import { verifyApiKey, type AuthedRequest } from "../middleware/auth";
import { requireExternalRail } from "../middleware/externalRail";
import { created, ok, err, validationError } from "../lib/response";
import { INTERVAL_SECONDS } from "../lib/checkout/complete";
import { supportedSourceChains } from "../lib/gateway/chains";

export const mandatesRouter = Router();

/// Every chain a mandate may be granted on: Arc, plus whatever source chains this
/// deployment supports. Read at request time so SUPPORTED_SOURCE_CHAINS still governs.
function allowedChains(): string[] {
  return ["arc", ...supportedSourceChains().map((c) => c.key)];
}

const INTERVALS = ["daily", "weekly", "monthly", "yearly"] as const;

const createSchema = z.object({
  external_ref: z.string().min(1).max(255),
  email: z.string().email().optional(),
  // USDC micro-units. An integer, because a float here is a rounding bug that
  // ends in someone being charged the wrong amount.
  max_amount: z.number().int().positive(),
  interval: z.enum(INTERVALS),
  chains: z.array(z.string()).min(1),
  expires_at: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
  return_url: z.string().url().optional(),
});

interface MandateRow {
  mandateId: string;
  externalRef: string;
  email: string | null;
  walletAddress: string | null;
  maxAmount: bigint;
  interval: string;
  periodDuration: number;
  chains: string[];
  status: string;
  isTestMode: boolean;
  expiresAt: Date;
  linkExpiresAt: Date;
  authorizedAt: Date | null;
  revokedAt: Date | null;
  metadata: unknown;
  createdAt: Date;
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "http://localhost:3000";
}

function serialize(m: MandateRow) {
  return {
    id: m.mandateId,
    mode: "external",
    status: m.status,
    external_ref: m.externalRef,
    email: m.email,
    // Null until the subscriber signs — which wallet authorizes is not known when
    // the mandate is created.
    wallet_address: m.walletAddress,
    max_amount: Number(m.maxAmount),
    currency: "USDC",
    interval: m.interval,
    period_duration: m.periodDuration,
    chains: m.chains,
    test_mode: m.isTestMode,
    // The authorization's own expiry, and separately the lifetime of the link the
    // subscriber opens. A developer who conflates them ships a broken email.
    expires_at: m.expiresAt.toISOString(),
    authorization_url: m.status === "pending" ? `${appUrl()}/authorize/${m.mandateId}` : null,
    authorization_url_expires_at: m.linkExpiresAt.toISOString(),
    authorized_at: m.authorizedAt?.toISOString() ?? null,
    revoked_at: m.revokedAt?.toISOString() ?? null,
    metadata: m.metadata,
    created_at: m.createdAt.toISOString(),
  };
}

const SELECT = {
  mandateId: true, externalRef: true, email: true, walletAddress: true,
  maxAmount: true, interval: true, periodDuration: true, chains: true,
  status: true, isTestMode: true, expiresAt: true, linkExpiresAt: true,
  authorizedAt: true, revokedAt: true, metadata: true, createdAt: true,
} as const;

// ─── POST /v1/mandates ────────────────────────────────────────────────────────
mandatesRouter.post("/", verifyApiKey, requireExternalRail, async (req, res) => {
  const { merchant, isTestMode } = req as AuthedRequest;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return validationError(
      res,
      Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "Invalid"])
      )
    );
  }
  const d = parsed.data;

  const allowed = allowedChains();
  const unknown = [...new Set(d.chains.map((c) => c.toLowerCase()))].filter((c) => !allowed.includes(c));
  if (unknown.length > 0) {
    return validationError(res, {
      chains: `Unsupported: ${unknown.join(", ")}. Supported: ${allowed.join(", ")}.`,
    });
  }

  const expiresAt = new Date(d.expires_at);
  if (expiresAt.getTime() <= Date.now()) {
    return validationError(res, { expires_at: "Must be in the future." });
  }

  const mandate = await prisma.mandate.create({
    data: {
      mandateId: ids.mandate(),
      merchantId: merchant.id,
      externalRef: d.external_ref,
      email: d.email ?? null,
      maxAmount: BigInt(d.max_amount),
      interval: d.interval,
      periodDuration: INTERVAL_SECONDS[d.interval] ?? INTERVAL_SECONDS.monthly,
      chains: [...new Set(d.chains.map((c) => c.toLowerCase()))],
      expiresAt,
      metadata: (d.metadata ?? {}) as Prisma.InputJsonValue,
      returnUrl: d.return_url ?? null,
      sessionToken: ids.sessionToken(),
      // The LINK's lifetime, not the mandate's. 24h matches checkout.
      linkExpiresAt: addHours(new Date(), 24),
      isTestMode,
    },
    select: SELECT,
  });

  return created(res, serialize(mandate));
});

// ─── GET /v1/mandates ─────────────────────────────────────────────────────────
mandatesRouter.get("/", verifyApiKey, requireExternalRail, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const { external_ref, status, limit: limitStr, offset: offsetStr } = req.query as Record<string, string>;
  const limit = Math.min(parseInt(limitStr ?? "20") || 20, 100);
  const offset = parseInt(offsetStr ?? "0") || 0;

  const where = {
    merchantId: merchant.id,
    ...(status && { status }),
    ...(external_ref && { externalRef: external_ref }),
  };

  const [rows, total] = await Promise.all([
    prisma.mandate.findMany({ where, select: SELECT, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.mandate.count({ where }),
  ]);

  return ok(res, { data: rows.map(serialize), count: rows.length, total });
});

// ─── GET /v1/mandates/:id ─────────────────────────────────────────────────────
mandatesRouter.get("/:id", verifyApiKey, requireExternalRail, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const mandate = await prisma.mandate.findFirst({
    where: { mandateId: req.params.id as string, merchantId: merchant.id },
    select: SELECT,
  });
  if (!mandate) return err(res, "Mandate not found", 404, "not_found");
  return ok(res, serialize(mandate));
});

// ─── DELETE /v1/mandates/:id ──────────────────────────────────────────────────
//
// Closes the authorization so no further charge can be made against it. It does
// NOT disable anything on chain: only the subscriber's own wallet can call
// disableDelegation (it is onlyDeleGator), so a revoke here is a decision this
// platform records and honours, not a cryptographic one. Say so in the docs
// rather than implying more than it does.
mandatesRouter.delete("/:id", verifyApiKey, requireExternalRail, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const mandate = await prisma.mandate.findFirst({
    where: { mandateId: req.params.id as string, merchantId: merchant.id },
    select: { id: true, status: true },
  });
  if (!mandate) return err(res, "Mandate not found", 404, "not_found");
  if (mandate.status === "revoked") {
    // Idempotent: a retry of a revoke is not an error, and returning 409 here
    // would make a developer's cleanup loop noisy for no reason.
    const current = await prisma.mandate.findUniqueOrThrow({ where: { id: mandate.id }, select: SELECT });
    return ok(res, serialize(current));
  }

  const updated = await prisma.mandate.update({
    where: { id: mandate.id },
    data: { status: "revoked", revokedAt: new Date() },
    select: SELECT,
  });
  return ok(res, serialize(updated));
});
