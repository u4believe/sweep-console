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
import { supportedSourceChains } from "../lib/gateway/chains";
import {
  getDelegateAddress,
  decodePeriodTransferTerms,
  delegationIdentity,
  mandateCovers,
} from "../lib/chain/delegation";
import { INTERVAL_SECONDS } from "../lib/checkout/complete";
import { executeCrossChainActivation } from "../lib/checkout/cctp-activate";
import { resolveCheckoutCustomer, verifyEmailToken } from "../lib/checkout/identity";
import {
  findWalletConflict,
  walletConflictMessage,
  identifyPayer,
} from "../lib/checkout/wallet-guard";
import { resolveTier } from "../lib/checkout/tiers";
import { ids } from "../lib/ids";

export const delegationRouter = Router();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
// Permit grants a year of renewals (matches the same-chain Arc checkout path).

// ─── GET /internal/checkout/:session_id/grant-plan ───────────────────────────
//
// Which chains the subscriber should grant a renewal delegation on: EVERY
// supported SOURCE chain (Base/Arbitrum/OP Sepolia), regardless of current USDC
// balance there — a chain funded after checkout should still be usable for
// renewals without a second grant flow. Arc is NOT a delegation target — it's
// the settlement chain and doesn't support ERC-7715
// (`wallet_requestExecutionPermissions`); Arc-funded renewals run on the
// allowance/permit model instead. The client requests a
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

    // Every supported source chain, regardless of current USDC balance — the
    // subscriber may fund a chain later, and the mandate just sits unused until
    // then. Arc itself is excluded — it can't host an ERC-7710 delegation.
    const targets: ReturnType<typeof target>[] = supportedSourceChains().map((src) =>
      target(src.chain.id, src.key, src.name, src.usdc)
    );

    // Which chains this wallet has ALREADY authorized — counted per chain, not
    // all-or-nothing, so a subscriber who granted only Base can come back and
    // add Arbitrum without being told they are already done.
    //
    // A grant counts if it belongs to THIS checkout session (per-session dedup)
    // or to a prior subscription with THIS merchant by the same wallet (a
    // returning customer is never asked to re-authorize a chain they already
    // covered). Each new subscription still gets its own fresh on-chain mandate.
    const existingGrants = await prisma.renewalDelegation.findMany({
      where: {
        status: "active",
        OR: [
          { sessionId: session.sessionId },
          {
            walletAddress: { equals: wallet, mode: "insensitive" },
            subscription: { is: { merchantId: session.merchantId } },
          },
        ],
      },
      select: { chainId: true, periodAmount: true, periodDuration: true },
    });
    // A chain counts as covered only if a mandate there can actually pay THIS
    // plan. Previously any active mandate on the chain counted, so a subscriber
    // holding a $5/day grant who moved to a $10/day plan was told they were
    // already authorized — and every renewal then failed `over_cap`, months
    // after the signature that could have prevented it.
    const grantedChainIds = [
      ...new Set(
        existingGrants
          .filter((g) => mandateCovers(g, amount, periodDuration))
          .map((g) => g.chainId)
      ),
    ];

    // "Already enabled" now means EVERY offered chain is covered — the toggle
    // only disappears when there is nothing left to authorize.
    const alreadyEnabled =
      targets.length > 0 && targets.every((t) => grantedChainIds.includes(t.chain_id));

    // No Arc permit. It funded Arc-first renewals and the escrow on cross-chain
    // activation, and neither exists now: Arc is the settlement chain, so nothing
    // is ever pulled from it and nothing is held.
    return ok(res, {
      targets,
      granted_chain_ids: grantedChainIds,
      already_enabled: alreadyEnabled,
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
    // Compare against the CHOSEN tier's price (same resolution as grant-plan
    // used to build the request) — not the plan's default amount, which can
    // legitimately differ from the tier the subscriber actually granted for.
    const tier = await resolveTier(session.plan, session.tierId);
    if (terms.periodAmount < tier.amount) {
      return err(
        res,
        `Granted cap ${terms.periodAmount} is below the plan price ${tier.amount} — renewals would be rejected`,
        400
      );
    }

    // Identity of the signed delegation, so the reconciler can later ask the chain
    // whether the subscriber has disabled it. Lives in `data` rather than being
    // create-only: a re-grant replaces `context`, so the identity changes with it.
    const identity = await delegationIdentity(
      d.chain_id,
      d.delegation_manager as Address,
      d.context as Hex
    );

    const data = {
      sessionId: session.sessionId,
      salt: identity.salt,
      delegationHash: identity.delegationHash,
      // Direct scope, so a mandate no longer has to reach its merchant through a
      // Subscription that may not exist yet. Safe in both branches — the merchant
      // is the same whether this is a first grant or a re-grant.
      merchantId: session.merchantId,
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
    // mandateId is create-only. A re-grant replaces the mandate's terms but is the
    // same mandate to anyone holding the id, so rotating it here would break every
    // reference a developer already has.
    const delegation = existing
      ? await prisma.renewalDelegation.update({ where: { id: existing.id }, data })
      : await prisma.renewalDelegation.create({
        // grantId is this row's public id. mandateId is still written because the
        // column is NOT NULL until the contract step retypes it as the FK to
        // Mandate — hosted grants have no Mandate, so it goes null there.
        data: { ...data, mandateId: ids.mandate(), grantId: ids.grant() },
      });

    return ok(res, { delegation_id: delegation.id, status: delegation.status });
  } catch (e) {
    console.error("[internal/checkout/delegation]", e);
    return err(res, "Failed to store renewal mandate", 500);
  }
});

// ─── POST /internal/checkout/:session_id/cross-chain/activate ─────────────────
//
// Arc-short cross-chain activation. The subscriber has already granted the
// delegation(s) via POST /delegation above. We fund
// + activate the subscription from a granted source chain (detached; the UI polls
// the sweep status). Idempotent per session — one non-failed sweep. The subscriber
// pays no fee; the platform covers gas + bridge from the platform fee on each charge.
const activateSchema = z.object({
  session_token: z.string().min(1),
  wallet_address: z.string().regex(ADDRESS_RE),
  email: z.string().email().optional(),
  email_token: z.string().optional(), // OTP proof, required to link a new wallet
  // No Arc permit. This path settles by minting the merchant's share straight to
  // their payout wallet — no SubscriptionManager call, so there is nothing for an
  // ERC-2612 allowance to feed. Older clients may still send permit_* fields;
  // unknown keys are ignored rather than rejected, so they keep working.
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

    // A wallet already carrying a live subscription for a DIFFERENT customer of
    // this merchant is spoken for — refuse here, before any funds move.
    const conflict = await findWalletConflict({
      merchantId: session.merchantId,
      walletAddress: d.wallet_address,
      identity: await identifyPayer({
        merchantId: session.merchantId,
        walletAddress: d.wallet_address,
        email: d.email,
        emailProven: !!d.email && verifyEmailToken(d.email_token, d.email),
      }),
    });
    if (conflict) return err(res, walletConflictMessage(conflict, session.merchant.name), 409);

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
        // Both from the customer just resolved against the OTP proof, so the
        // detached run below never has to guess who is paying.
        subscriberEmail: customer.email,
        customerId: customer.customerDbId,
      },
    });

    // Detached — the checkout UI polls GET /checkout/:id/sweep/:sweep_id.
    executeCrossChainActivation(sweep.id).catch((e) =>
      console.error("[cross-chain/activate] detached run crashed:", e)
    );

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

    // A wallet already carrying a live subscription for a DIFFERENT customer of
    // this merchant is spoken for — refuse here, before any funds move.
    const conflict = await findWalletConflict({
      merchantId: session.merchantId,
      walletAddress: d.wallet_address,
      identity: await identifyPayer({
        merchantId: session.merchantId,
        walletAddress: d.wallet_address,
        email: d.email,
        emailProven: !!d.email && verifyEmailToken(d.email_token, d.email),
      }),
    });
    if (conflict) return err(res, walletConflictMessage(conflict), 409);

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
  // Revoke a single chain's mandate. Omit to revoke every chain at once — the
  // "turn the whole thing off" path.
  chain_id: z.number().int().positive().optional(),
});

delegationRouter.post("/internal/checkout/:session_id/grant-revoke", async (req, res) => {
  const parsed = grantRevokeSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid revoke payload", 422);
  const { session_token, wallet_address, chain_id } = parsed.data;
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
        // Scoped to one chain when asked; every chain otherwise. Grants are
        // stored one row per chain, so this leaves the others untouched.
        ...(chain_id !== undefined ? { chainId: chain_id } : {}),
      },
      data: { status: "revoked" },
    });
    return ok(res, { revoked: result.count, chain_id: chain_id ?? null });
  } catch (e) {
    console.error("[cross-chain/grant-revoke]", e);
    return err(res, "Failed to revoke grant", 500);
  }
});
