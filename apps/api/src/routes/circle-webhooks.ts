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

circleWebhooksRouter.post("/", (req, res) => {
  // IP allowlist is ADVISORY only. Circle rotates its sender IPs and Railway (and
  // most hosts) proxy the request, so hard-blocking on IP rejects real + test
  // deliveries. The ECDSA signature check below is the actual security gate.
  const clientIp =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ??
    req.socket.remoteAddress ??
    "";
  if (process.env.NODE_ENV === "production" && clientIp && !CIRCLE_IPS.has(clientIp)) {
    console.warn(`[circle-webhook] sender IP not in known list (not blocking): ${clientIp}`);
  }

  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: "Unexpected body type" });
  }

  // ACK immediately with 2xx so Circle's connection test + deliveries always
  // succeed; verification + processing happen out of band below.
  res.status(200).json({ ok: true });

  const signature = req.headers["x-circle-signature"] as string | undefined;
  const keyId     = req.headers["x-circle-key-id"]     as string | undefined;

  void (async () => {
    // Only ACT on cryptographically verified events.
    if (!signature || !keyId) {
      console.warn("[circle-webhook] missing signature headers — not processing");
      return;
    }
    let verified = false;
    try {
      const publicKey = await getVerifyKey(keyId);
      verified = cryptoVerify("sha256", rawBody, publicKey, Buffer.from(signature, "base64"));
    } catch (e) {
      console.error("[circle-webhook] signature verification error:", (e as Error).message);
      return;
    }
    if (!verified) {
      console.warn("[circle-webhook] invalid signature — ignoring event");
      return;
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString("utf-8")) as WebhookPayload;
    } catch {
      return;
    }
    console.log(`[circle-webhook] ${payload.notificationType} | id=${payload.notificationId}`);

    const n = payload.notification;
    const isInboundUsdc =
      payload.notificationType === "transactions.inbound" &&
      n?.operation === "INBOUND" &&
      (n?.state === "CONFIRMED" || n?.state === "COMPLETE") &&
      n?.token?.symbol === "USDC";
    if (isInboundUsdc) await handleInboundDeposit(n!);
  })();
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
