import { Router } from "express";
import express from "express";
import { createPublicKey, verify as cryptoVerify } from "crypto";
import { prisma, withRetry } from "../lib/prisma";
import { IS_PRODUCTION } from "../lib/env";
import { getWebhookPublicKey, getCircleWalletBalances, circleBlockchain, usdcOnSettlementChain } from "../lib/circle";
import { ids } from "../lib/ids";
import { walletWrite } from "../lib/merchant-wallet";

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

interface TransferNotification {
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
  notification?: TransferNotification;
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
  if (IS_PRODUCTION && clientIp && !CIRCLE_IPS.has(clientIp)) {
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

    /**
     * A payout LEAVING a Circle-held payout wallet.
     *
     * This is the only place the transaction hash of a withdrawal appears.
     * POST /portal/wallet/circle/withdraw creates a Circle challenge and the
     * browser executes it; that SDK callback reports an error or nothing, so
     * neither side of our code learns the hash from the request path.
     *
     * Recorded on SENT as well as CONFIRMED/COMPLETE, because a creator
     * watching the dashboard should see the payout the moment it is on its
     * way, not a minute later — the state travels with it and the row is
     * updated in place as Circle progresses it.
     */
    const isOutboundUsdc =
      payload.notificationType === "transactions.outbound" &&
      n?.operation === "OUTBOUND" &&
      n?.token?.symbol === "USDC";
    if (isOutboundUsdc) await handleOutboundWithdrawal(n!);
  })();
});

async function handleInboundDeposit(n: TransferNotification): Promise<void> {
  const { walletId, amounts, txHash, state } = n;
  console.log(
    `[circle-webhook] Inbound ${amounts[0] ?? "?"} USDC to wallet ${walletId} | state=${state} | tx=${txHash}`
  );

  try {
    const merchant = await withRetry(() =>
      prisma.merchant.findFirst({
        // Either half. A merchant holds a Circle wallet per environment, and
        // searching only the test column means a live wallet's webhook finds
        // no merchant and the balance is never refreshed — silently, because
        // "no merchant for this wallet" is a warning, not an error.
        where: { OR: [{ circleWalletId: walletId }, { liveCircleWalletId: walletId }] },
        select: { id: true, email: true, circleWalletId: true },
      })
    );

    if (!merchant) {
      console.warn(`[circle-webhook] No merchant found for Circle wallet ${walletId}`);
      return;
    }

    const read = await getCircleWalletBalances(walletId);

    // A webhook says the balance CHANGED, so a failed read here is the one
    // moment the cache is most certainly wrong. Leaving the old value is still
    // better than writing a zero that Circle never reported: the next read
    // refreshes it, and a false zero would survive until then.
    if (!read.ok) {
      console.warn(`[circle-webhook] balance read failed for ${walletId}: ${read.reason}`);
      return;
    }

    /**
     * Same selection the portal makes, for the same reason — and here it
     * matters more, because this runs unattended.
     *
     * A wallet registered on the wrong chain reports no USDC on ours, and
     * writing the "0" that follows would cache a false zero over real money
     * with nobody watching. The warning above about not writing zeros Circle
     * never reported applies just as much to zeros Circle reported for the
     * wrong chain.
     */
    const pick        = usdcOnSettlementChain(read.balances);
    if (!pick.found && pick.elsewhere.length > 0) {
      const where = pick.elsewhere.map((b) => `${b.amount} on ${b.token.blockchain}`).join(", ");
      console.warn(
        `[circle-webhook] ${walletId} holds USDC on the wrong chain (${where}); this deployment ` +
          `settles to ${circleBlockchain()} — not writing a balance. Check CIRCLE_BLOCKCHAIN.`
      );
      return;
    }
    const newBalance  = pick.found?.amount ?? "0";

    await withRetry(() =>
      prisma.merchant.update({
        where: { id: merchant.id },
        // Write back to the half that matched, not to test by default.
        data: walletWrite(merchant.circleWalletId === walletId, {
          usdcBalance: newBalance,
          balanceUpdatedAt: new Date(),
        }),
      })
    );

    console.log(`[circle-webhook] Merchant ${merchant.id} (${merchant.email}) balance updated to ${newBalance} USDC`);
  } catch (e) {
    console.error("[circle-webhook] Failed to process deposit:", e);
  }
}

/**
 * Record a payout out of a Circle payout wallet, so it can appear in the
 * dashboard's recent activity with a link to the transaction.
 *
 * WHICH COLUMN MATCHED IS THE MODE. A merchant holds one Circle wallet per
 * environment. Finding them by `circleWalletId` means this was the test
 * wallet; by `liveCircleWalletId`, the live one. That is recorded on the row
 * rather than re-derived later, because the explorer the hash is linked to
 * depends on it and a row that cannot say which network it was on is a link
 * nobody can trust.
 *
 * Keyed on txHash, which Circle repeats across the SENT -> CONFIRMED ->
 * COMPLETE notifications for one transfer. So this upserts: the first
 * notification creates the row, the rest advance its state. Without that, one
 * withdrawal would appear three times.
 */
async function handleOutboundWithdrawal(n: TransferNotification): Promise<void> {
  const { walletId, amounts, txHash, state, destinationAddress } = n;
  console.log(
    `[circle-webhook] Outbound ${amounts[0] ?? "?"} USDC from wallet ${walletId} | state=${state} | tx=${txHash}`
  );
  if (!txHash) {
    // Circle sends an INITIATED notification before the transaction exists.
    // Nothing to key on and nothing a creator could click, so it is skipped
    // rather than stored as a row with a null hash that never fills in.
    console.log(`[circle-webhook] outbound with no txHash yet (state=${state}) — skipped`);
    return;
  }

  try {
    const merchant = await withRetry(() =>
      prisma.merchant.findFirst({
        where: { OR: [{ circleWalletId: walletId }, { liveCircleWalletId: walletId }] },
        select: { id: true, circleWalletId: true, liveCircleWalletId: true },
      })
    );
    if (!merchant) {
      console.warn(`[circle-webhook] No merchant found for Circle wallet ${walletId}`);
      return;
    }

    // The test wallet unless it is demonstrably the live one. Erring towards
    // test means a mislabelled row links to the testnet explorer, where the
    // hash is simply absent — the other way round, a live payout would be
    // linked to a testnet page and look like a lost payment.
    const isTestMode = merchant.liveCircleWalletId !== walletId;

    // Circle reports USDC in whole units ("12.5"); the column is micro-units.
    const raw = amounts[0] ?? "0";
    const micro = BigInt(Math.round(parseFloat(raw) * 1_000_000));
    const settled = state === "CONFIRMED" || state === "COMPLETE";

    await withRetry(() =>
      prisma.walletWithdrawal.upsert({
        where: { txHash },
        create: {
          withdrawalId: ids.withdrawal(),
          merchantId: merchant.id,
          amount: micro,
          state,
          destination: destinationAddress ?? null,
          txHash,
          circleWalletId: walletId,
          isTestMode,
          confirmedAt: settled ? new Date() : null,
        },
        // Only the state moves. The amount, destination and mode were settled
        // by the first notification and a later one restating them differently
        // would be Circle contradicting itself, not new information.
        update: {
          state,
          ...(settled ? { confirmedAt: new Date() } : {}),
        },
      })
    );
    console.log(`[circle-webhook] withdrawal recorded tx=${txHash} state=${state} test=${isTestMode}`);
  } catch (e) {
    // A webhook that throws is retried by Circle; a withdrawal missing from
    // the activity list is a display gap, not a lost payout.
    console.error(`[circle-webhook] could not record withdrawal ${txHash}:`, e);
  }
}
