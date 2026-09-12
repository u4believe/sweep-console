// /v1/charges — the external rail's collection endpoint.
//
// One capped pull against a mandate, when the developer's own billing logic says
// it is time. This is the first endpoint in the platform where a stolen API key
// directly enriches whoever holds it, which is why it sits behind both
// verifyApiKey and requireExternalRail, and why the Idempotency-Key header is
// mandatory rather than advisory.
//
// It answers 202, never 200. Every charge is cross-chain — Arc cannot back a
// mandate — so collection is a pull, a burn, an attestation and a mint: seconds
// to minutes. The charge row exists the moment we answer; the money arrives later
// and the developer learns by webhook or by polling GET /v1/charges/:id.
//
// The per-period ceiling is enforced HERE, against the mandate, because on-chain
// it is not: each grant carries its own enforcer cap, so a subscriber who signs
// on two chains has two independent ceilings and "up to 5 USDC per day" silently
// means 5 per day per chain. The signed caps still bound every individual redeem
// — nothing here can exceed them — but only this sum makes the number the
// subscriber was shown the number they actually agreed to.

import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ids } from "../lib/ids";
import { verifyApiKey, type AuthedRequest } from "../middleware/auth";
import { requireExternalRail } from "../middleware/externalRail";
import { ok, err, validationError } from "../lib/response";
import { claimKey, completeKey, releaseKey, hashRequest } from "../lib/idempotency";
import { executeCharge } from "../billing/direct-charge";
import { mandatePeriodStart, periodCommitted } from "../lib/rail";

export const chargesRouter = Router();

const createSchema = z.object({
  mandate: z.string().min(1),
  // USDC micro-units, integer for the same reason the mandate's ceiling is.
  amount: z.number().int().positive(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});

interface ChargeRow {
  chargeId: string;
  amount: bigint;
  currency: string;
  status: string;
  description: string | null;
  externalRef: string | null;
  metadata: unknown;
  isTestMode: boolean;
  chain: string | null;
  txHash: string | null;
  failureReason: string | null;
  createdAt: Date;
  settledAt: Date | null;
  mandate: { mandateId: string };
}

function serialize(c: ChargeRow) {
  return {
    id: c.chargeId,
    mandate: c.mandate.mandateId,
    status: c.status,
    amount: Number(c.amount),
    currency: c.currency,
    description: c.description,
    external_ref: c.externalRef,
    metadata: c.metadata,
    test_mode: c.isTestMode,
    // The chain the funds came FROM. Settlement is always on Arc, so tx_hash is
    // the Arc mint — reporting one without the other is how a developer ends up
    // looking for a Base transaction that does not exist.
    source_chain: c.chain,
    settlement_chain: c.status === "succeeded" ? "arc" : null,
    tx_hash: c.txHash,
    failure_reason: c.failureReason,
    created_at: c.createdAt.toISOString(),
    settled_at: c.settledAt?.toISOString() ?? null,
  };
}

const SELECT = {
  chargeId: true, amount: true, currency: true, status: true, description: true,
  externalRef: true, metadata: true, isTestMode: true, chain: true, txHash: true,
  failureReason: true, createdAt: true, settledAt: true,
  mandate: { select: { mandateId: true } },
} as const;

// ─── POST /v1/charges ─────────────────────────────────────────────────────────
chargesRouter.post("/", verifyApiKey, requireExternalRail, async (req, res) => {
  const { merchant, isTestMode } = req as AuthedRequest;

  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.trim().length === 0) {
    return err(
      res,
      "An Idempotency-Key header is required. Send a unique value per charge so a retry cannot collect twice.",
      400,
      "idempotency_key_required"
    );
  }

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

  // Claim the key BEFORE looking anything up, so two identical requests racing
  // each other cannot both reach the mandate.
  const claim = await claimKey(merchant.id, key.trim(), hashRequest(d));
  if (claim.kind === "replay") {
    return res.status(claim.status).json(claim.body);
  }
  if (claim.kind === "conflict") {
    return claim.reason === "body_mismatch"
      ? err(
          res,
          "This Idempotency-Key was already used with a different request body. Use a new key for a new charge.",
          422,
          "idempotency_key_reused"
        )
      : err(
          res,
          "A charge with this Idempotency-Key is already in progress. Retry shortly.",
          409,
          "idempotency_key_in_flight"
        );
  }

  // Reading the mandate, checking the ceiling and reserving against it happen in
  // ONE serializable transaction. The ceiling is a sum over existing charges, so
  // checking it outside the write is a read-then-write race: two requests with
  // different idempotency keys both see an empty period and both collect the full
  // amount. Serializable is what makes the sum below a fact at commit time rather
  // than a guess from a moment ago.
  let outcome:
    | { kind: "ok"; charge: ChargeRow & { id: string } }
    | { kind: "refused"; status: number; message: string; code: string };
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const mandate = await tx.mandate.findFirst({
          where: { mandateId: d.mandate, merchantId: merchant.id },
          select: {
            id: true, mandateId: true, status: true, externalRef: true,
            maxAmount: true, periodDuration: true, authorizedAt: true, createdAt: true,
          },
        });
        if (!mandate) {
          return { kind: "refused" as const, status: 404, message: "Mandate not found", code: "not_found" };
        }

        // Refusals that need no on-chain lookup are answered synchronously,
        // because a developer would rather be told "revoked" now than poll for it.
        if (mandate.status !== "active") {
          return {
            kind: "refused" as const,
            status: 409,
            message: `This mandate is ${mandate.status}, so it cannot be charged.`,
            code: mandate.status === "revoked" ? "mandate_revoked" : "mandate_not_active",
          };
        }
        if (BigInt(d.amount) > mandate.maxAmount) {
          return {
            kind: "refused" as const,
            status: 422,
            message: `${d.amount} exceeds the ${mandate.maxAmount} per-period ceiling the subscriber authorized.`,
            code: "amount_over_cap",
          };
        }

        // The ceiling belongs to the MANDATE, not to a chain. Each grant carries
        // its own enforcer cap, so a subscriber who signed on two chains has two
        // independent on-chain ceilings — and without this, "up to 5 USDC per day"
        // meant 5 per day per chain. The signed caps still bound each redeem; this
        // is what makes the number the subscriber was shown the real one.
        const since = mandatePeriodStart(mandate);
        const committed = await periodCommitted(tx, mandate.id, since);
        const remaining = mandate.maxAmount - committed;
        if (BigInt(d.amount) > remaining) {
          return {
            kind: "refused" as const,
            status: 422,
            message:
              `${d.amount} exceeds what is left of this mandate's ${mandate.maxAmount} ceiling for the ` +
              `current period: ${committed} is already committed, leaving ${remaining < 0n ? 0n : remaining}. ` +
              `The period resets at ${new Date(since.getTime() + mandate.periodDuration * 1000).toISOString()}.`,
            code: "period_cap_exceeded",
          };
        }

        const created = await tx.charge.create({
          data: {
            chargeId: ids.charge(),
            merchantId: merchant.id,
            mandateId: mandate.id,
            amount: BigInt(d.amount),
            status: "pending",
            description: d.description ?? null,
            // Copied at charge time rather than read through the relation, so the
            // event reflects what the mandate said when the charge was made.
            externalRef: mandate.externalRef,
            metadata: (d.metadata ?? {}) as Prisma.InputJsonValue,
            isTestMode,
          },
          select: { ...SELECT, id: true },
        });
        return { kind: "ok" as const, charge: created };
      },
      { isolationLevel: "Serializable" }
    );
  } catch (e) {
    // Two charges against one mandate can genuinely collide here. That is the
    // transaction doing its job, not an error the developer caused — tell them to
    // retry rather than leaving the key claimed and the outcome unknown.
    await releaseKey(claim.id);
    const code = (e as { code?: string }).code;
    if (code === "P2034") {
      return err(
        res,
        "Another charge against this mandate committed at the same moment. Retry with the same Idempotency-Key.",
        409,
        "charge_conflict"
      );
    }
    throw e;
  }

  if (outcome.kind === "refused") {
    await releaseKey(claim.id);
    return err(res, outcome.message, outcome.status, outcome.code);
  }
  const charge = outcome.charge;

  const body = serialize(charge);
  await completeKey(claim.id, 202, body);

  // Detached: the collection outlives this request by design. executeCharge never
  // throws — a charge that cannot be collected records itself as failed, because
  // an unhandled rejection here is a charge nobody hears about again.
  void executeCharge(charge.id);

  return res.status(202).json(body);
});

// ─── GET /v1/charges/:id ──────────────────────────────────────────────────────
chargesRouter.get("/:id", verifyApiKey, requireExternalRail, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const charge = await prisma.charge.findFirst({
    where: { chargeId: req.params.id as string, merchantId: merchant.id },
    select: SELECT,
  });
  if (!charge) return err(res, "Charge not found", 404, "not_found");
  return ok(res, serialize(charge));
});

// ─── GET /v1/charges ──────────────────────────────────────────────────────────
chargesRouter.get("/", verifyApiKey, requireExternalRail, async (req, res) => {
  const { merchant } = req as AuthedRequest;
  const { mandate, status, limit: limitStr, offset: offsetStr } = req.query as Record<string, string>;
  const limit = Math.min(parseInt(limitStr ?? "20") || 20, 100);
  const offset = parseInt(offsetStr ?? "0") || 0;

  const where = {
    merchantId: merchant.id,
    ...(status && { status }),
    ...(mandate && { mandate: { mandateId: mandate } }),
  };

  const [rows, total] = await Promise.all([
    prisma.charge.findMany({ where, select: SELECT, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.charge.count({ where }),
  ]);

  return ok(res, { data: rows.map(serialize), count: rows.length, total });
});
