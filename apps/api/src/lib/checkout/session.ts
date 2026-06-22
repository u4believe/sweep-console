// Shared checkout-session creation.
//
// Used by both the API-key flow (POST /v1/checkout/sessions) and Payment Links
// (GET /pay/:link_id). A session can only open once the merchant has a payout
// wallet, and an external (path B) payout address must be ownership-verified —
// the contract pushes settled funds straight there, so we never open checkout
// for a missing or unverified payout wallet.

import { addHours } from "date-fns";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { ids } from "../ids";

export class SessionCreationError extends Error {
  constructor(message: string, public httpStatus: number, public code?: string) {
    super(message);
  }
}

export interface CreateSessionInput {
  merchantId: string;
  plan: { id: string };
  externalRef: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Prisma.InputJsonValue;
  isTestMode: boolean;
}

export async function createCheckoutSession(input: CreateSessionInput) {
  const payout = await prisma.merchant.findUniqueOrThrow({
    where: { id: input.merchantId },
    select: { walletAddress: true, walletType: true, addressVerifiedAt: true },
  });
  if (!payout.walletAddress) {
    throw new SessionCreationError(
      "No payout wallet configured. Link one in the Developer Portal first.",
      409,
      "payout_wallet_missing"
    );
  }
  if (payout.walletType === "external" && !payout.addressVerifiedAt) {
    throw new SessionCreationError(
      "Payout wallet ownership is not verified. Verify it in the Developer Portal first.",
      409,
      "payout_wallet_unverified"
    );
  }

  const sessionId = ids.session(!input.isTestMode);
  const sessionToken = ids.sessionToken();
  const expiresAt = addHours(new Date(), 24);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const session = await prisma.checkoutSession.create({
    data: {
      sessionId,
      merchantId: input.merchantId,
      planId: input.plan.id,
      externalRef: input.externalRef,
      successUrl: input.successUrl.replace("{SESSION_ID}", sessionId),
      cancelUrl: input.cancelUrl,
      metadata: input.metadata ?? {},
      sessionToken,
      isTestMode: input.isTestMode,
      expiresAt,
    },
  });

  return {
    session,
    checkoutUrl: `${appUrl}/checkout/${sessionId}`,
  };
}
