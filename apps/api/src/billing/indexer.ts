// On-chain event indexer — keeps the DB mirror honest.
//
// The Subscription rows in Postgres are a mirror of contract state, and the API
// is not the only writer: SubscriptionManager.cancelSubscription() is callable by
// the subscriber themselves, so a cancel (which refunds settlement-window escrow
// to them) can happen with no API request at all. Without this indexer that
// subscription stays "active" with a pending payment forever, and the hourly
// settlement sweep retries a settlePeriod() that can never succeed.
//
// It also self-heals the write-then-crash window: settlePeriod()/refund() land
// on-chain, the process dies before committing, and the mirror is left stale.
//
// Every handler is idempotent and only acts when the DB still disagrees with the
// chain, so replaying a block range is safe.

import { prisma } from "../lib/prisma";
import { getPublicClient, getManagerAddress } from "../lib/chain/contract";
import { SUBSCRIPTION_MANAGER_ABI } from "../lib/chain/abi";
import { fireWebhook } from "../lib/webhooks/delivery";
import { ids } from "../lib/ids";

const CURSOR_NAME = "subscription_manager";

/// Blocks behind head to stay, so a reorg doesn't strand us on an orphaned log.
const CONFIRMATIONS = 5n;

/// Max span per getLogs call — most RPCs reject wider ranges.
const CHUNK = 5_000n;

/// How far back to start when there is no cursor yet (first ever run). Arc runs
/// ~0.5s blocks (~169k/day), so this is roughly one day — enough to cover a
/// worker outage without a 40-minute cold scan. Set INDEXER_START_BLOCK to
/// backfill further (e.g. the contract's deploy block) on the first run.
const COLD_START_LOOKBACK = 200_000n;

const INDEXED_EVENTS = SUBSCRIPTION_MANAGER_ABI.filter(
  (item): item is Extract<(typeof SUBSCRIPTION_MANAGER_ABI)[number], { type: "event" }> =>
    item.type === "event" &&
    (item.name === "SubscriptionCancelled" ||
      item.name === "PeriodSettled" ||
      item.name === "Refunded")
);

// Only one pass at a time — ticks can overlap if a range is slow to scan.
let running = false;

export async function runIndexerOnce(): Promise<void> {
  if (running) {
    console.log("[indexer] previous pass still running — skipping this tick");
    return;
  }
  running = true;
  try {
    await indexPass();
  } catch (e) {
    if ((e as { code?: string }).code === "P2021") {
      console.error(
        "[indexer] indexer_cursors table is missing — run: pnpm --filter @sweep/api db:push"
      );
      return;
    }
    console.error("[indexer] pass failed:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

async function indexPass(): Promise<void> {
  const publicClient = getPublicClient();
  const address = getManagerAddress();
  const chainId = await publicClient.getChainId();

  const head = await publicClient.getBlockNumber();
  const safeHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;

  let from = await loadCursor(chainId, safeHead);
  if (from > safeHead) return; // nothing new that is deep enough to trust

  while (from <= safeHead) {
    const to = from + CHUNK - 1n > safeHead ? safeHead : from + CHUNK - 1n;

    const logs = await publicClient.getLogs({
      address,
      events: INDEXED_EVENTS,
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      try {
        await handleLog(log as IndexedLog);
      } catch (e) {
        // One bad row must not wedge the cursor behind it forever.
        console.error(
          `[indexer] failed handling ${(log as IndexedLog).eventName} in tx ${log.transactionHash}:`,
          e instanceof Error ? e.message : e
        );
      }
    }

    // Commit progress per chunk so a crash mid-pass doesn't replay everything.
    await saveCursor(chainId, to);
    if (logs.length > 0) {
      console.log(`[indexer] blocks ${from}–${to}: processed ${logs.length} event(s)`);
    }
    from = to + 1n;
  }
}

// ─── Cursor ───────────────────────────────────────────────────────────────────

async function loadCursor(chainId: number, safeHead: bigint): Promise<bigint> {
  const row = await prisma.indexerCursor.findUnique({
    where: { name_chainId: { name: CURSOR_NAME, chainId } },
  });
  if (row) return row.lastBlock + 1n;

  const configured = process.env.INDEXER_START_BLOCK;
  const start = configured
    ? BigInt(configured)
    : safeHead > COLD_START_LOOKBACK
      ? safeHead - COLD_START_LOOKBACK
      : 0n;
  console.log(`[indexer] no cursor for chain ${chainId} — cold starting at block ${start}`);
  return start;
}

async function saveCursor(chainId: number, lastBlock: bigint): Promise<void> {
  await prisma.indexerCursor.upsert({
    where: { name_chainId: { name: CURSOR_NAME, chainId } },
    create: { name: CURSOR_NAME, chainId, lastBlock },
    update: { lastBlock },
  });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

interface IndexedLog {
  eventName: "SubscriptionCancelled" | "PeriodSettled" | "Refunded";
  args: Record<string, unknown>;
  transactionHash: string | null;
  blockNumber: bigint | null;
}

async function handleLog(log: IndexedLog): Promise<void> {
  const subId = log.args.subId as string | undefined;
  if (!subId) return;

  const sub = await prisma.subscription.findFirst({
    where: { onChainSubId: subId },
    include: { plan: true, merchant: true },
  });
  // A checkout that never completed, or another environment sharing the
  // contract — nothing to reconcile.
  if (!sub) return;

  switch (log.eventName) {
    case "SubscriptionCancelled":
      return onCancelled(sub, log);
    case "PeriodSettled":
      return onSettled(sub, log);
    case "Refunded":
      return onRefunded(sub, log);
  }
}

type SubRow = NonNullable<
  Awaited<
    ReturnType<
      typeof prisma.subscription.findFirst<{ include: { plan: true; merchant: true } }>
    >
  >
>;

/// The contract returned escrow to the subscriber. The merchant was NOT paid, so
/// the pending payment becomes "refunded" — marking it succeeded would report
/// money the merchant never received.
async function onCancelled(sub: SubRow, log: IndexedLog): Promise<void> {
  // Already reconciled (usually because the cancel came through our own API,
  // which cancels the DB row and fires the webhook itself).
  if (sub.status === "cancelled" && sub.escrowBalance === 0n) return;

  const refundedEscrow = (log.args.refundedEscrow as bigint | undefined) ?? 0n;

  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelReason: sub.cancelReason ?? "cancelled_on_chain",
        escrowBalance: 0n,
        settlementDeadline: null,
      },
    }),
    prisma.payment.updateMany({
      where: { subscriptionId: sub.id, status: "pending" },
      data: { status: "refunded" },
    }),
    prisma.renewalDelegation.updateMany({
      where: { subscriptionId: sub.id, status: "active" },
      data: { status: "revoked" },
    }),
  ]);

  console.warn(
    `[indexer] ${sub.subscriptionId} cancelled on-chain outside the API — ` +
      `reconciled (escrow ${refundedEscrow} returned to subscriber) tx=${log.transactionHash}`
  );

  await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "subscription.cancelled", {
    subscription_id: sub.subscriptionId,
    plan_id: sub.plan.planId,
    cancel_reason: "cancelled_on_chain",
    wallet_address: sub.walletAddress,
    cancelled_at: new Date().toISOString(),
    refunded_escrow: Number(refundedEscrow),
    tx_hash: log.transactionHash,
    block_number: log.blockNumber !== null ? Number(log.blockNumber) : null,
  });
}

/// Escrow was pushed to the merchant. Only acts when the DB missed it — i.e. the
/// settlement sweep's transaction landed but its commit didn't.
async function onSettled(sub: SubRow, log: IndexedLog): Promise<void> {
  if (sub.escrowBalance === 0n) return;

  const merchantShare = (log.args.merchantShare as bigint | undefined) ?? 0n;
  const platformFee = (log.args.platformFee as bigint | undefined) ?? 0n;
  const settledAmount = sub.escrowBalance;

  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: sub.id },
      data: { escrowBalance: 0n, settlementDeadline: null },
    }),
    prisma.payment.updateMany({
      where: { subscriptionId: sub.id, status: "pending" },
      data: { status: "succeeded" },
    }),
  ]);

  console.warn(
    `[indexer] ${sub.subscriptionId} settled on-chain but not recorded — reconciled tx=${log.transactionHash}`
  );

  await fireWebhook(sub.merchantId, sub.externalRef, sub.merchant.merchantId, "payment.succeeded", {
    subscription_id: sub.subscriptionId,
    plan_id: sub.plan.planId,
    amount: Number(settledAmount),
    merchant_share: Number(merchantShare),
    platform_fee: Number(platformFee),
    currency: sub.plan.currency,
    type: "settlement",
    tx_hash: log.transactionHash,
    block_number: log.blockNumber !== null ? Number(log.blockNumber) : null,
    chain: "arc",
  });
}

/// Partial or full refund out of escrow. The refund API records its own Payment,
/// so only create one when this tx has no row yet.
async function onRefunded(sub: SubRow, log: IndexedLog): Promise<void> {
  const amount = (log.args.amount as bigint | undefined) ?? 0n;
  if (amount === 0n) return;

  const alreadyRecorded = await prisma.payment.findFirst({
    where: { subscriptionId: sub.id, txHash: log.transactionHash, type: "refund" },
  });
  if (alreadyRecorded) return;

  const remaining = sub.escrowBalance > amount ? sub.escrowBalance - amount : 0n;

  await prisma.$transaction([
    prisma.subscription.update({
      where: { id: sub.id },
      data: {
        escrowBalance: remaining,
        ...(remaining === 0n ? { settlementDeadline: null } : {}),
      },
    }),
    prisma.payment.create({
      data: {
        paymentId: ids.payment(),
        merchantId: sub.merchantId,
        subscriptionId: sub.id,
        amount,
        currency: sub.plan.currency,
        status: "succeeded",
        type: "refund",
        isTestMode: sub.isTestMode,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        chain: "arc",
      },
    }),
  ]);

  console.warn(
    `[indexer] ${sub.subscriptionId} refund not recorded by the API — reconciled tx=${log.transactionHash}`
  );
}
