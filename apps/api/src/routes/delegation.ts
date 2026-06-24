// Tier-2 grant persistence (ERC-7710).
//
// The checkout client performs the one-time `wallet_requestExecutionPermissions`
// and POSTs the resulting permission context here. We bind it to the checkout session;
// completeCheckoutSession later links it to the Subscription. The relayer reads
// these rows to redeem renewals — no further subscriber interaction.

import { Router } from "express";
import { z } from "zod";
import type { Address, Hex } from "viem";
import { prisma } from "../lib/prisma";
import { ok, err } from "../lib/response";
import { scanWalletBalances } from "../lib/gateway/balances";
import { getSourceChain } from "../lib/gateway/chains";
import { getDelegateAddress, decodePeriodTransferTerms } from "../lib/chain/delegation";
import { INTERVAL_SECONDS } from "../lib/checkout/complete";
import {
  buildPermitPayload,
  executeCrossChainActivation,
} from "../lib/checkout/cctp-activate";
import { resolveCheckoutCustomer } from "../lib/checkout/identity";
import { resolveTier } from "../lib/checkout/tiers";
import { ids } from "../lib/ids";

export const delegationRouter = Router();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
// Permit grants a year of renewals (matches the same-chain Arc checkout path).
const ALLOWANCE_PERIODS = 12n;

// ─── GET /internal/checkout/:session_id/grant-plan ───────────────────────────
//
// Which chains the subscriber should grant a renewal delegation on: every
// supported SOURCE chain (Base/Arbitrum/OP Sepolia) whose wallet currently holds
// at least one period. Arc is NOT a delegation target — it's the settlement chain
// and doesn't support ERC-7715 (`wallet_requestExecutionPermissions`); Arc-funded
// renewals run on the allowance/permit model instead. The client requests a
// `wallet_requestExecutionPermissions` per target and POSTs each context back.
delegationRouter.get("/internal/checkout/:session_id/grant-plan", async (req, res) => {
  const wallet = String(req.query.wallet ?? "");
  if (!ADDRESS_RE.test(wallet)) return err(res, "Invalid or missing ?wallet", 400);

  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: req.params.session_id as string },
      include: { plan: true },
    });
    if (!session) return err(res, "Checkout session not found", 404);

    // The renewal mandate cap + period follow the CHOSEN tier (or default tier).
    const tier = await resolveTier(session.plan, session.tierId);
    const amount = tier.amount;
    const periodDuration = INTERVAL_SECONDS[tier.interval] ?? INTERVAL_SECONDS.monthly;
    const delegate = getDelegateAddress();

    const target = (chainId: number, key: string, name: string, token: string) => ({
      chain_id: chainId,
      chain_key: key,
      name,
      token,
      period_amount: amount.toString(),
      period_duration: periodDuration,
      delegate,
    });

    // Source chains only — Arc can't host an ERC-7710 delegation.
    const targets: ReturnType<typeof target>[] = [];
    const balances = await scanWalletBalances(wallet as Hex);
    for (const c of balances.chains) {
      if (c.walletBalance < amount) continue; // only chains that can fund a renewal
      const src = getSourceChain(c.chainKey);
      targets.push(target(src.chain.id, src.key, src.name, src.usdc));
    }

    // Cross-chain is "enabled" — skip re-granting + the whole toggle — in two cases:
    //   1. THIS checkout session already has grants (per-session dedup), or
    //   2. the CONNECTED WALLET already enabled cross-chain renewals for THIS
    //      merchant on a prior subscription (returning customer, same wallet) —
    //      so they're never re-offered it.
    // A brand-new wallet, or a returning Arc-only wallet that never granted, still
    // sees the offer. Each new subscription gets its own fresh on-chain mandate.
    const sessionGrants = await prisma.renewalDelegation.count({
      where: { sessionId: session.sessionId, status: "active" },
    });
    const walletGrantsForMerchant = await prisma.renewalDelegation.count({
      where: {
        walletAddress: { equals: wallet, mode: "insensitive" },
        status: "active",
        subscription: { is: { merchantId: session.merchantId } },
      },
    });
    const alreadyEnabled = sessionGrants > 0 || walletGrantsForMerchant > 0;

    // Arc permit (recurring allowance) — funds Arc-first renewals + the escrow on
    // cross-chain activation.
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const permitValue = amount * ALLOWANCE_PERIODS;
    const permitDeadline = nowSec + 3_600n;
    const permitPayload = await buildPermitPayload(wallet as Hex, permitValue, permitDeadline);

    return ok(res, {
      targets,
      already_enabled: alreadyEnabled,
      permit_payload: permitPayload,
      permit_value: permitValue.toString(),
      permit_deadline: permitDeadline.toString(),
    });
  } catch (e) {
    console.error("[internal/checkout/grant-plan]", e);
    return err(res, "Failed to build grant plan", 500);
  }
});

const grantSchema = z.object({
  wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  account_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  delegate_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chain_id: z.number().int().positive(),
  token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  delegation_manager: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  context: z.string().regex(/^0x[a-fA-F0-9]+$/),
  // ERC-7715 account-deployment deps the relayer needs on the first redeem if
  // the delegator account isn't deployed yet (EIP-7702). Empty for deployed accounts.
  dependencies: z
    .array(
      z.object({
        factory: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        factoryData: z.string().regex(/^0x[a-fA-F0-9]*$/),
      })
    )
    .optional(),
  period_amount: z.string().regex(/^\d+$/),
  period_duration: z.number().int().positive(),
  expiry: z.number().int().nonnegative(),
});

delegationRouter.post("/internal/checkout/:session_id/delegation", async (req, res) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid delegation grant", 400);

  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: req.params.session_id as string },
      include: { plan: true },
    });
    if (!session) return err(res, "Checkout session not found", 404);

    const d = parsed.data;

    // The signed context is the source of truth for the per-period cap — decode it
    // and persist THAT, not the client-supplied period_amount, so a renewal never
    // tries to pull more than the wallet actually authorized. Reject a grant that
    // carries no matching mandate, or whose cap can't cover one plan charge (it
    // would only ever revert on-chain at renewal time).
    const terms = decodePeriodTransferTerms(d.context as Hex, d.token as Address);
    if (!terms) {
      return err(res, `Delegation has no erc20 period-transfer permission for token ${d.token}`, 400);
    }
    if (terms.periodAmount < session.plan.amount) {
      return err(
        res,
        `Granted cap ${terms.periodAmount} is below the plan price ${session.plan.amount} — renewals would be rejected`,
        400
      );
    }

    const data = {
      sessionId: session.sessionId,
      walletAddress: d.wallet_address,
      accountAddress: d.account_address ?? d.wallet_address,
      delegateAddress: d.delegate_address,
      chainId: d.chain_id,
      token: d.token,
      periodAmount: terms.periodAmount,
      periodDuration: terms.periodDuration,
      // expiry === 0 means the wallet didn't echo one back; fall back to the
      // requested one-year mandate so the row still carries a sane bound.
      expiry: new Date((d.expiry || Math.floor(Date.now() / 1000) + 31_536_000) * 1000),
      delegationManager: d.delegation_manager,
      context: d.context,
      dependencies: d.dependencies ?? [],
      status: "active",
    };

    // Idempotent per (session, chain): re-granting the same chain replaces the
    // stored mandate instead of stacking duplicates.
    const existing = await prisma.renewalDelegation.findFirst({
      where: { sessionId: session.sessionId, chainId: d.chain_id, status: "active" },
    });
    const delegation = existing
      ? await prisma.renewalDelegation.update({ where: { id: existing.id }, data })
      : await prisma.renewalDelegation.create({ data });

    return ok(res, { delegation_id: delegation.id, status: delegation.status });
  } catch (e) {
    console.error("[internal/checkout/delegation]", e);
    return err(res, "Failed to store renewal mandate", 500);
  }
});

// ─── POST /internal/checkout/:session_id/cross-chain/activate ─────────────────
//
// Arc-short cross-chain activation. The subscriber has already granted the
// delegation(s) via POST /delegation above, and now signs the Arc permit. We fund
// + activate the subscription from a granted source chain (detached; the UI polls
// the sweep status). Idempotent per session — one non-failed sweep. The subscriber
// pays no fee; the platform covers gas + bridge from the 2% fee on each charge.
const activateSchema = z.object({
  session_token: z.string().min(1),
  wallet_address: z.string().regex(ADDRESS_RE),
  email: z.string().email().optional(),
  email_token: z.string().optional(), // OTP proof, required to link a new wallet
  permit_signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
  permit_value: z.string().regex(/^\d+$/),
  permit_deadline: z.string().regex(/^\d+$/),
});

delegationRouter.post("/internal/checkout/:session_id/cross-chain/activate", async (req, res) => {
  const parsed = activateSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid activation payload", 422);
  const d = parsed.data;

  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: req.params.session_id as string },
      include: { plan: true, merchant: true },
    });
    if (!session) return err(res, "Checkout session not found", 404);
    if (session.sessionToken !== d.session_token) return err(res, "Invalid session token", 401);
    if (session.status !== "open" || new Date() > session.expiresAt) {
      return err(res, `Session is ${session.status === "open" ? "expired" : session.status}`, 409);
    }

    // Idempotency: one non-failed sweep per session.
    const existing = await prisma.sweep.findFirst({
      where: { sessionId: session.id, status: { not: "failed" } },
    });
    if (existing) return ok(res, { sweep_id: existing.sweepId, status: existing.status });

    // A verified customer link is REQUIRED before moving any funds — no link, no
    // activation. A known wallet recalls; a new wallet needs the OTP email_token.
    const customer = await resolveCheckoutCustomer({
      merchantId: session.merchantId,
      walletAddress: d.wallet_address,
      email: d.email,
      emailToken: d.email_token,
    });
    if (!customer) {
      return err(res, "Verify your email before paying.", 403);
    }

    const sweep = await prisma.sweep.create({
      data: {
        sweepId: ids.sweep(),
        sessionId: session.id,
        walletAddress: d.wallet_address.toLowerCase(),
        status: "depositing",
        totalAmount: session.plan.amount,
        priceAmount: session.plan.amount,
        subscriberEmail: d.email?.trim().toLowerCase() ?? null,
      },
    });

    // Detached — the checkout UI polls GET /checkout/:id/sweep/:sweep_id.
    executeCrossChainActivation(sweep.id, {
      permitSignature: d.permit_signature as Hex,
      permitValue: BigInt(d.permit_value),
      permitDeadline: BigInt(d.permit_deadline),
    }).catch((e) => console.error("[cross-chain/activate] detached run crashed:", e));

    return ok(res, { sweep_id: sweep.sweepId, status: "depositing" });
  } catch (e) {
    console.error("[cross-chain/activate]", e);
    return err(res, e instanceof Error ? e.message : "Failed to start activation", 500);
  }
});

// ─── POST /internal/checkout/:session_id/cross-chain/enable ───────────────────
//
// PROACTIVE enable for an Arc-funded subscriber: they pay (and activate) on Arc as
// usual, and ALSO turn on cross-chain so renewals can pull from a source chain when
// their Arc balance runs dry. The delegation grants are POSTed via /delegation
// above (source chains only — Arc is the L1 settlement chain, not a CCTP source).
// This endpoint just confirms the enable: no fee, no fund movement. No activation
// here — the Arc checkout creates the subscription and links the session's
// delegations to it; if the subscriber paid first, we link them now.
const enableSchema = z.object({
  session_token: z.string().min(1),
  wallet_address: z.string().regex(ADDRESS_RE),
  email: z.string().email().optional(),
  email_token: z.string().optional(), // OTP proof, required to link a new wallet
});

delegationRouter.post("/internal/checkout/:session_id/cross-chain/enable", async (req, res) => {
  const parsed = enableSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid enable payload", 422);
  const d = parsed.data;

  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: req.params.session_id as string },
    });
    if (!session) return err(res, "Checkout session not found", 404);
    if (session.sessionToken !== d.session_token) return err(res, "Invalid session token", 401);

    // Verified customer link required before enabling renewals on this wallet.
    const customer = await resolveCheckoutCustomer({
      merchantId: session.merchantId,
      walletAddress: d.wallet_address,
      email: d.email,
      emailToken: d.email_token,
    });
    if (!customer) return err(res, "Verify your email before enabling cross-chain.", 403);

    // Normally enable happens BEFORE the Arc payment, so completeCheckoutSession
    // links the session's grants to the new subscription. If the subscriber paid
    // first, the subscription already exists — link the grants now so renewals can
    // find them (order-independent).
    if (session.subscriptionId) {
      const sub = await prisma.subscription.findUnique({
        where: { subscriptionId: session.subscriptionId },
      });
      if (sub) {
        await prisma.renewalDelegation.updateMany({
          where: { sessionId: session.sessionId, subscriptionId: null },
          data: { subscriptionId: sub.id },
        });
      }
    }

    return ok(res, { enabled: true });
  } catch (e) {
    console.error("[cross-chain/enable]", e);
    return err(res, e instanceof Error ? e.message : "Failed to enable cross-chain", 500);
  }
});

// ─── POST /internal/checkout/:session_id/grant-revoke ────────────────────────
// Revoke the cross-chain renewal grant the subscriber just enabled in THIS
// checkout (before any subscription exists). Marks the session's active,
// not-yet-linked delegations revoked so the relayer can never redeem them. The
// subscriber can also revoke the permission on-chain in their wallet for full control.
const grantRevokeSchema = z.object({
  session_token: z.string().min(1),
  wallet_address: z.string().regex(ADDRESS_RE),
});

delegationRouter.post("/internal/checkout/:session_id/grant-revoke", async (req, res) => {
  const parsed = grantRevokeSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid revoke payload", 422);
  const { session_token, wallet_address } = parsed.data;
  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: req.params.session_id as string },
    });
    if (!session) return err(res, "Checkout session not found", 404);
    if (session.sessionToken !== session_token) return err(res, "Invalid session token", 401);

    const result = await prisma.renewalDelegation.updateMany({
      where: {
        sessionId: session.sessionId,
        walletAddress: { equals: wallet_address, mode: "insensitive" },
        status: "active",
        subscriptionId: null,
      },
      data: { status: "revoked" },
    });
    return ok(res, { revoked: result.count });
  } catch (e) {
    console.error("[cross-chain/grant-revoke]", e);
    return err(res, "Failed to revoke grant", 500);
  }
});
