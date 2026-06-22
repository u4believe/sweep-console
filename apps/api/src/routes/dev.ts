// Dev-only diagnostics (registered only when NODE_ENV !== "production").
//
// POST /dev/test-transfer-redeem — simulate the C1 primitive: the relayer redeems
// the subscriber's ERC-7715 periodic mandate as a single `transfer(recipient,
// amount)`. Simulate-only; nothing moves.
//
// POST /dev/test-bridge-burn + /dev/test-bridge-receive — exercise the REAL CCTP
// bridge: the relayer burns its own USDC on a source chain, then (separately, so
// neither request hangs on Iris) fetches the attestation and mints on Arc. These
// MOVE real testnet funds from the relayer's balance.

import { Router } from "express";
import { z } from "zod";
import type { Address, Hex } from "viem";
import { ok, err } from "../lib/response";
import { prisma } from "../lib/prisma";
import { ids } from "../lib/ids";
import {
  simulatePeriodicTransfer,
  relayerBridgeToArc,
  getDelegateAddress,
  decodePeriodTransferTerms,
} from "../lib/chain/delegation";
import { fetchAttestation, getTokenMessenger, receiveOnArc } from "../lib/gateway/cctp";
import { chainKeyForId, getSourceChain, ARC_DOMAIN } from "../lib/gateway/chains";
import { runDelegatedRenewalsOnce } from "../billing/delegated-renewal";

export const devRouter = Router();

// Fixed dev merchant the integration harness seeds against (re-used across runs).
const DEV_EMAIL = "dev-tier2@example.com";
const DEV_PLAN_ID = "plan_devtier2";

// ─── POST /dev/seed-delegated-sub ────────────────────────────────────────────
// Seeds a DUE subscription + a real granted mandate so a renewal pass has work to
// do. Re-uses a fixed dev merchant/plan; creates a fresh subscription each call.
const seedSchema = z.object({
  wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/), // subscriber (the granting account)
  creator: z.string().regex(/^0x[a-fA-F0-9]{40}$/), // merchant payout
  chain_id: z.number().int().positive(),
  delegation_manager: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  context: z.string().regex(/^0x[a-fA-F0-9]+$/),
  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().regex(/^\d+$/),
  period_duration: z.number().int().positive(),
});

devRouter.post("/dev/seed-delegated-sub", async (req, res) => {
  const parsed = seedSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 400);
  const d = parsed.data;

  // The amount the renewal pass redeems is bounded by the cap baked into the
  // signed `context`. Seeding a plan/mandate amount that disagrees with it would
  // only fail later on-chain (transfer-amount-exceeded), so reject it here.
  const terms = decodePeriodTransferTerms(d.context as Hex, d.token as Address);
  if (!terms) {
    return err(res, `context has no erc20 period-transfer permission for token ${d.token}`, 400);
  }
  if (BigInt(d.amount) !== terms.periodAmount) {
    return err(res, `amount ${d.amount} does not match the signed delegation cap ${terms.periodAmount}`, 400);
  }
  if (d.period_duration !== terms.periodDuration) {
    return err(res, `period_duration ${d.period_duration} does not match the signed cap ${terms.periodDuration}`, 400);
  }

  try {
    const merchant = await prisma.merchant.upsert({
      where: { email: DEV_EMAIL },
      update: { walletAddress: d.creator },
      create: {
        merchantId: ids.merchant(),
        email: DEV_EMAIL,
        name: "Dev Tier-2 Test",
        webhookSecret: "dev-webhook-secret",
        passwordHash: "dev",
        walletAddress: d.creator,
      },
    });
    const plan = await prisma.plan.upsert({
      where: { planId: DEV_PLAN_ID },
      update: { amount: BigInt(d.amount), merchantId: merchant.id },
      create: {
        planId: DEV_PLAN_ID,
        merchantId: merchant.id,
        name: "Dev Tier-2 Plan",
        amount: BigInt(d.amount),
        currency: "USDC",
        interval: "monthly",
      },
    });

    const now = new Date();
    const sub = await prisma.subscription.create({
      data: {
        subscriptionId: ids.subscription(),
        merchantId: merchant.id,
        planId: plan.id,
        externalRef: "dev-tier2",
        walletAddress: d.wallet,
        status: "active",
        activationMethod: "wallet",
        isTestMode: true,
        currentPeriodStart: new Date(now.getTime() - d.period_duration * 1000),
        currentPeriodEnd: new Date(now.getTime() - 60_000), // DUE: 1 min ago
      },
    });
    const mandate = await prisma.renewalDelegation.create({
      data: {
        subscriptionId: sub.id,
        walletAddress: d.wallet,
        accountAddress: d.wallet,
        delegateAddress: getDelegateAddress(),
        chainId: d.chain_id,
        token: d.token,
        periodAmount: BigInt(d.amount),
        periodDuration: d.period_duration,
        expiry: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
        delegationManager: d.delegation_manager,
        context: d.context,
        status: "active",
      },
    });

    return ok(res, { subscription_id: sub.subscriptionId, sub_id: sub.id, mandate_id: mandate.id });
  } catch (e) {
    console.error("[dev/seed-delegated-sub]", e);
    return err(res, e instanceof Error ? e.message : "Seed failed", 500);
  }
});

// ─── POST /dev/run-delegated-renewals ────────────────────────────────────────
// Runs ONE renewal pass (bypassing the TIER2 flag) and returns the dev merchant's
// subscriptions with their latest payments + bridge transfers. MOVES REAL FUNDS.
devRouter.post("/dev/run-delegated-renewals", async (_req, res) => {
  try {
    const outcomes = await runDelegatedRenewalsOnce();

    const merchant = await prisma.merchant.findUnique({ where: { email: DEV_EMAIL } });
    if (!merchant) return ok(res, { outcomes, subscriptions: [] });

    const subs = await prisma.subscription.findMany({
      where: { merchantId: merchant.id },
      include: {
        payments: { orderBy: { createdAt: "desc" }, take: 3 },
        bridgeTransfers: { orderBy: { createdAt: "desc" }, take: 3 },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    return ok(res, {
      outcomes,
      subscriptions: subs.map((s) => ({
        subscription_id: s.subscriptionId,
        status: s.status,
        current_period_end: s.currentPeriodEnd,
        payments: s.payments.map((p) => ({
          payment_id: p.paymentId,
          status: p.status,
          amount: p.amount.toString(),
          tx_hash: p.txHash,
          chain: p.chain,
        })),
        bridges: s.bridgeTransfers.map((b) => ({
          status: b.status,
          burn_tx: b.burnTxHash,
          mint_tx: b.mintTxHash,
          gross: b.grossAmount.toString(),
        })),
      })),
    });
  } catch (e) {
    console.error("[dev/run-delegated-renewals]", e);
    return err(res, e instanceof Error ? e.message : "Run failed", 500);
  }
});

// ─── POST /dev/clear-delegated-subs ──────────────────────────────────────────
// Removes the dev merchant's subscriptions + their mandates/bridges/payments so
// re-runs start clean.
devRouter.post("/dev/clear-delegated-subs", async (_req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { email: DEV_EMAIL } });
    if (!merchant) return ok(res, { cleared: 0 });

    const subs = await prisma.subscription.findMany({
      where: { merchantId: merchant.id },
      select: { id: true },
    });
    const subIds = subs.map((s) => s.id);

    await prisma.$transaction([
      prisma.bridgeTransfer.deleteMany({ where: { subscriptionId: { in: subIds } } }),
      prisma.renewalDelegation.deleteMany({ where: { subscriptionId: { in: subIds } } }),
      prisma.payment.deleteMany({ where: { subscriptionId: { in: subIds } } }),
      prisma.subscription.deleteMany({ where: { id: { in: subIds } } }),
    ]);

    return ok(res, { cleared: subIds.length });
  } catch (e) {
    console.error("[dev/clear-delegated-subs]", e);
    return err(res, e instanceof Error ? e.message : "Clear failed", 500);
  }
});

// ─── POST /dev/test-transfer-redeem ──────────────────────────────────────────
const transferSchema = z.object({
  chain_id: z.number().int().positive(),
  delegation_manager: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  context: z.string().regex(/^0x[a-fA-F0-9]+$/),
  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().regex(/^\d+$/),
});

devRouter.post("/dev/test-transfer-redeem", async (req, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 400);
  const d = parsed.data;

  try {
    const result = await simulatePeriodicTransfer({
      chainId: d.chain_id,
      delegationManager: d.delegation_manager as Address,
      context: d.context as Hex,
      token: d.token as Address,
      recipient: d.recipient as Address,
      amount: BigInt(d.amount),
    });
    return ok(res, result);
  } catch (e) {
    console.error("[dev/test-transfer-redeem]", e);
    return err(res, e instanceof Error ? e.message : "Simulation failed", 500);
  }
});

// ─── POST /dev/test-bridge-burn ──────────────────────────────────────────────
// MOVES FUNDS: the relayer burns `amount` of its OWN USDC on the source chain
// toward Arc (mintRecipient). Returns the burn tx + source domain for the receive.
const burnSchema = z.object({
  chain_id: z.number().int().positive(),
  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  amount: z.string().regex(/^\d+$/),
  mint_recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  speed: z.enum(["fast", "standard"]).default("standard"),
});

devRouter.post("/dev/test-bridge-burn", async (req, res) => {
  const parsed = burnSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 400);
  const d = parsed.data;

  const chainKey = chainKeyForId(d.chain_id);
  if (!chainKey || chainKey === "arc") {
    return err(res, "chain_id must be a supported source chain", 400);
  }

  try {
    const source = getSourceChain(chainKey);
    const { burnTxHash } = await relayerBridgeToArc({
      chainId: d.chain_id,
      token: d.token as Address,
      tokenMessenger: getTokenMessenger(chainKey),
      amount: BigInt(d.amount),
      destinationDomain: ARC_DOMAIN,
      mintRecipient: d.mint_recipient as Address,
      speed: d.speed,
    });
    return ok(res, { burn_tx_hash: burnTxHash, source_domain: source.domain });
  } catch (e) {
    console.error("[dev/test-bridge-burn]", e);
    return err(res, e instanceof Error ? e.message : "Bridge burn failed", 500);
  }
});

// ─── POST /dev/test-bridge-receive ───────────────────────────────────────────
// Polls Iris briefly for the burn's attestation; if ready, mints on Arc and
// returns the mint tx. If the attestation isn't ready yet, returns { pending:true }
// so the harness can retry (rather than hang for the full attestation window).
const receiveSchema = z.object({
  source_domain: z.number().int().nonnegative(),
  burn_tx_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

devRouter.post("/dev/test-bridge-receive", async (req, res) => {
  const parsed = receiveSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 400);
  const d = parsed.data;

  try {
    const att = await fetchAttestation(d.source_domain, d.burn_tx_hash as Hex, {
      timeoutMs: 60_000,
      pollMs: 5_000,
    });
    const mintTxHash = await receiveOnArc(att);
    return ok(res, { mint_tx_hash: mintTxHash });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Timed out")) return ok(res, { pending: true });
    console.error("[dev/test-bridge-receive]", e);
    return err(res, msg, 500);
  }
});
