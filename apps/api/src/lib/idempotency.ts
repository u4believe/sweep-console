// Idempotency-Key for the public charge API.
//
// The renewal path gets this free from RenewalClaim's @@unique([subscriptionId,
// periodKey]) — a period is a natural lock. A charge API has no period key to lean
// on: a developer's retry loop is the only thing that says "this is the same
// request", so it needs the real mechanism, built on the identical trick.
//
// The unique constraint IS the lock. A caught P2002 means the key was already
// used, and the right answer is to replay what we said the first time rather than
// move funds again. A retry loop must never double-charge.
//
// Three outcomes, and the third is the one people forget:
//   fresh     — nobody has used this key; go do the work
//   replay    — same key, same body: hand back the stored response verbatim
//   conflict  — same key, DIFFERENT body: that is a recycled key, which is a bug
//               in the caller. 422, not a silent replay, so the mistake surfaces.
//
// An "in_flight" record whose request never completed is also a conflict of sorts:
// two identical requests raced, and only one may proceed. The loser is told to
// retry rather than being given a half-finished answer.

import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/// sha256 over the canonical body. Key order must not change the hash, or a
/// client that serialises its JSON differently on a retry would look like a
/// recycled key.
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export type IdempotencyOutcome =
  | { kind: "fresh"; id: string }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "conflict"; reason: "body_mismatch" | "in_flight" };

/// Claim `key` for this merchant and body. On "fresh" the caller owns the work and
/// MUST finish with complete() or release().
export async function claimKey(
  merchantId: string,
  key: string,
  requestHash: string
): Promise<IdempotencyOutcome> {
  try {
    const row = await prisma.idempotencyKey.create({
      data: { merchantId, key, requestHash, status: "in_flight" },
      select: { id: true },
    });
    return { kind: "fresh", id: row.id };
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
  }

  const existing = await prisma.idempotencyKey.findUnique({
    where: { merchantId_key: { merchantId, key } },
    select: { requestHash: true, status: true, responseStatus: true, responseBody: true },
  });
  // Deleted between the failed create and this read — vanishingly unlikely, but
  // telling the caller to retry is honest and safe.
  if (!existing) return { kind: "conflict", reason: "in_flight" };
  if (existing.requestHash !== requestHash) return { kind: "conflict", reason: "body_mismatch" };
  if (existing.status !== "completed" || existing.responseStatus === null) {
    return { kind: "conflict", reason: "in_flight" };
  }
  return { kind: "replay", status: existing.responseStatus, body: existing.responseBody };
}

/// Store the response so a later retry of the same key replays it.
export async function completeKey(id: string, status: number, body: unknown): Promise<void> {
  await prisma.idempotencyKey.update({
    where: { id },
    data: { status: "completed", responseStatus: status, responseBody: body as Prisma.InputJsonValue },
  });
}

/// Drop the claim so the SAME key can be retried. Call ONLY when the request
/// moved no funds — otherwise the record must stand, or a retry would charge again.
export async function releaseKey(id: string): Promise<void> {
  await prisma.idempotencyKey.deleteMany({ where: { id } });
}
