import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Merchant } from "@prisma/client";

export type AuthResult =
  | { ok: true; merchant: Merchant; isTestMode: boolean }
  | { ok: false; error: string; status: number };

/**
 * Verifies the Bearer API key from the Authorization header.
 * Accepts both live_ and test_ keys.
 * Uses timing-safe comparison to prevent timing attacks on HMAC verification.
 */
export async function verifyApiKey(req: NextRequest): Promise<AuthResult> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, error: "Missing or malformed Authorization header", status: 401 };
  }

  const rawKey = authHeader.slice("Bearer ".length).trim();
  if (!rawKey) {
    return { ok: false, error: "Empty API key", status: 401 };
  }

  const isTestKey = rawKey.startsWith("test_");
  const isLiveKey = rawKey.startsWith("live_");

  if (!isTestKey && !isLiveKey) {
    return { ok: false, error: "Invalid API key format", status: 401 };
  }

  // We can't bcrypt-compare against all merchants efficiently, so we use HMAC
  // where the secret is the platform's internal signing key. The stored hash is
  // HMAC-SHA256(rawKey, PLATFORM_API_SIGNING_SECRET).
  const expected = hmacKey(rawKey);

  const merchants = await prisma.merchant.findMany({
    select: { id: true, liveKeyHash: true, testKeyHash: true,
               merchantId: true, email: true, name: true,
               webhookSecret: true, walletAddress: true, isLive: true,
               createdAt: true, updatedAt: true },
  });

  for (const merchant of merchants) {
    const storedHash = isLiveKey ? merchant.liveKeyHash : merchant.testKeyHash;
    if (safeCompare(expected, storedHash)) {
      if (isLiveKey && !merchant.isLive) {
        return { ok: false, error: "Live API key is not active for this account", status: 403 };
      }
      return { ok: true, merchant, isTestMode: isTestKey };
    }
  }

  return { ok: false, error: "Invalid API key", status: 401 };
}

export function hmacKey(rawKey: string): string {
  const secret = process.env.PLATFORM_API_SIGNING_SECRET;
  if (!secret) throw new Error("PLATFORM_API_SIGNING_SECRET is not set");
  return createHmac("sha256", secret).update(rawKey).digest("hex");
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
