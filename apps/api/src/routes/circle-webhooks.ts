import { Router } from "express";
import express from "express";
import { createPublicKey, verify as cryptoVerify } from "crypto";
import { prisma, withRetry } from "../lib/prisma";
import { getWebhookPublicKey, getCircleWalletBalances } from "../lib/circle";

export const circleWebhooksRouter = Router();

// Raw body required for signature verification — must be mounted before express.json()
circleWebhooksRouter.use(express.raw({ type: "application/json" }));

// Circle's fixed sender IP addresses (from their docs)
const CIRCLE_IPS = new Set(["54.243.112.156", "100.24.191.35", "54.165.52.248", "54.87.106.46"]);

// Cache public keys by keyId — static per ID, safe to keep in memory
const pubKeyCache = new Map<string, ReturnType<typeof createPublicKey>>();

async function getVerifyKey(keyId: string): Promise<ReturnType<typeof createPublicKey>> {
  const cached = pubKeyCache.get(keyId);
  if (cached) return cached;
  const base64Key = await getWebhookPublicKey(keyId);
  const key = createPublicKey({ key: Buffer.from(base64Key, "base64"), format: "der", type: "spki" });
  pubKeyCache.set(keyId, key);
  return key;
}

interface InboundNotification {
  walletId: string;
  destinationAddress: string;
  amounts: string[];
  txHash: string;
  state: string;        // "CONFIRMED" | "COMPLETE"
  operation: string;    // "INBOUND" | "OUTBOUND"
  token: { id: string; symbol: string; decimals: number };
}

interface WebhookPayload {
  subscriptionId?: string;
  notificationId: string;
  notificationType: string;
  notification?: InboundNotification;
  timestamp: string;
  version: number;
}

circleWebhooksRouter.post("/", async (req, res) => {
  // IP allowlist — only enforced in production
  const clientIp =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ??
    req.socket.remoteAddress ??
    "";

  if (process.env.NODE_ENV === "production" && !CIRCLE_IPS.has(clientIp)) {
    console.warn(`[circle-webhook] Rejected — unknown sender IP: ${clientIp}`);
    return res.status(403).json({ error: "Forbidden" });
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: "Unexpected body type" });
  }

  const signature = req.headers["x-circle-signature"] as string | undefined;
  const keyId     = req.headers["x-circle-key-id"]     as string | undefined;

  if (signature && keyId) {
    try {
      const publicKey = await getVerifyKey(keyId);
      const sigBytes  = Buffer.from(signature, "base64");
      const valid     = cryptoVerify("sha256", rawBody, publicKey, sigBytes);
      if (!valid) {
        console.warn("[circle-webhook] ECDSA signature invalid — rejecting");
        return res.status(401).json({ error: "Invalid signature" });
      }
    } catch (e) {
      console.error("[circle-webhook] Signature verification error:", (e as Error).message);
      if (process.env.NODE_ENV === "production") {
        return res.status(401).json({ error: "Signature verification failed" });
      }
    }
  } else {
    console.warn("[circle-webhook] Missing signature headers — skipping verification (dev only)");
    if (process.env.NODE_ENV === "production") {
      return res.status(401).json({ error: "Missing signature headers" });
    }
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf-8")) as WebhookPayload;
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  console.log(`[circle-webhook] ${payload.notificationType} | id=${payload.notificationId}`);

  // Acknowledge within 5 seconds; process the rest asynchronously
  res.status(200).json({ ok: true });

  const n = payload.notification;
  const isInboundUsdc =
    payload.notificationType === "transactions.inbound" &&
    n?.operation === "INBOUND" &&
    (n?.state === "CONFIRMED" || n?.state === "COMPLETE") &&
    n?.token?.symbol === "USDC";

  if (isInboundUsdc) {
    void handleInboundDeposit(n!);
  }
});

async function handleInboundDeposit(n: InboundNotification): Promise<void> {
  const { walletId, amounts, txHash, state } = n;
  console.log(
    `[circle-webhook] Inbound ${amounts[0] ?? "?"} USDC to wallet ${walletId} | state=${state} | tx=${txHash}`
  );

  try {
    const merchant = await withRetry(() =>
      prisma.merchant.findFirst({
        where: { circleWalletId: walletId },
        select: { id: true, email: true },
      })
    );

    if (!merchant) {
      console.warn(`[circle-webhook] No merchant found for Circle wallet ${walletId}`);
      return;
    }

    const balances    = await getCircleWalletBalances(walletId);
    const usdc        = balances.find((b) => b.token.symbol === "USDC");
    const newBalance  = usdc?.amount ?? "0";

    await withRetry(() =>
      prisma.merchant.update({
        where: { id: merchant.id },
        data: { usdcBalance: newBalance, balanceUpdatedAt: new Date() },
      })
    );

    console.log(`[circle-webhook] Merchant ${merchant.id} (${merchant.email}) balance updated to ${newBalance} USDC`);
  } catch (e) {
    console.error("[circle-webhook] Failed to process deposit:", e);
  }
}
