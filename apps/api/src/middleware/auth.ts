import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { err } from "../lib/response";
import type { Merchant } from "@prisma/client";

export interface AuthedRequest extends Request {
  merchant: Merchant;
  isTestMode: boolean;
}

export async function verifyApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    err(res, "Missing or malformed Authorization header", 401);
    return;
  }

  const rawKey = authHeader.slice("Bearer ".length).trim();
  if (!rawKey) {
    err(res, "Empty API key", 401);
    return;
  }

  const isTestKey = rawKey.startsWith("test_");
  const isLiveKey = rawKey.startsWith("live_");

  if (!isTestKey && !isLiveKey) {
    err(res, "Invalid API key format", 401);
    return;
  }

  // Live keys are not issued yet: nothing writes Merchant.liveKeyHash, and the only
  // key the portal mints is ids.apiKey(false). Without this, a live_ key would fall
  // through the loop below and come back "Invalid API key" — sending whoever holds
  // it to look for a typo in a key that could never have worked. Say the real thing
  // instead. Remove this once issuance lands and the branch below can actually match.
  if (isLiveKey) {
    err(res, "Live API keys are not available yet. Use your test key.", 403, "live_keys_unavailable");
    return;
  }

  const secret = process.env.PLATFORM_API_SIGNING_SECRET;
  if (!secret) {
    err(res, "Server misconfiguration", 500);
    return;
  }

  const expected = createHmac("sha256", secret).update(rawKey).digest("hex");

  const merchants = await prisma.merchant.findMany({
    select: {
      id: true, liveKeyHash: true, testKeyHash: true,
      merchantId: true, email: true, name: true,
      webhookSecret: true, walletAddress: true, walletType: true,
      passwordHash: true, isLive: true, createdAt: true, updatedAt: true,
    },
  });

  for (const merchant of merchants) {
    const storedHash = isLiveKey ? merchant.liveKeyHash : merchant.testKeyHash;
    if (storedHash && safeCompare(expected, storedHash)) {
      if (isLiveKey && !merchant.isLive) {
        err(res, "Live API key is not active for this account", 403);
        return;
      }
      (req as AuthedRequest).merchant = merchant as Merchant;
      (req as AuthedRequest).isTestMode = isTestKey;
      next();
      return;
    }
  }

  err(res, "Invalid API key", 401);
}

function safeCompare(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}
