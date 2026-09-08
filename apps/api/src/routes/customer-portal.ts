// Standalone cross-merchant customer portal (session-less).
//
// The merchant-scoped /customer/* routes in public.ts require a checkout session.
// These power the public /manage page: a customer proves email ownership ONCE via
// OTP (email_token — email-global, not merchant-scoped) and manages EVERY
// subscription they hold across ALL merchants: view, cancel (gasless, returns any
// settlement-window escrow), and enable/revoke the cross-chain renewal grant per
// subscription. Email is the identity anchor, so no checkout session is involved.

import { Router } from "express";
import { z } from "zod";
import type { Address, Hex } from "viem";
import { prisma } from "../lib/prisma";
import { ok, err } from "../lib/response";
import { ids } from "../lib/ids";
import { verifyEmailToken, normalizeEmail } from "../lib/checkout/identity";
import { revokeSubscription } from "../lib/subscriptions/revoke";
import { supportedSourceChains, chainKeyForId } from "../lib/gateway/chains";
import {
  getDelegateAddress,
  decodePeriodTransferTerms,
  delegationIdentity,
  mandateCovers,
} from "../lib/chain/delegation";
import { INTERVAL_SECONDS } from "../lib/checkout/complete";

export const customerPortalRouter = Router();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MANDATE_FALLBACK_SEC = 31_536_000; // 1 year

// Email + OTP proof carried on every portal request (the email_token is the gate).
const proofSchema = z.object({
  email: z.string().email(),
  email_token: z.string().min(1),
});

/**
 * The alternative proof accepted by the two GRANT routes only.
 *
 * A subscriber who was recognised by their wallet at checkout never did an OTP,
 * so they hold no email_token — and were shown no renewal options at all. But
 * they do hold the token for the checkout session that just paid, and that
 * session is a strictly stronger claim than an emailed code: it already
 * authorised a real payment. It is scoped to the ONE subscription it produced.
 *
 * This does not move the identity anchor. The subscription still belongs to the
 * email-anchored Customer, webhooks still carry that customerId, and receipts
 * still go to that address. Only the proof-of-caller changes.
 */
const sessionProofSchema = z.object({
  session_id: z.string().min(1),
  session_token: z.string().min(1),
});

const grantProofSchema = z.union([proofSchema, sessionProofSchema]);
type GrantProof = z.infer<typeof grantProofSchema>;

function isSessionProof(p: GrantProof): p is z.infer<typeof sessionProofSchema> {
  return "session_token" in p;
}

/// Resolves the subscription either proof refers to, or null if the proof
/// doesn't hold. Both paths return the same shape, so the routes below don't
/// care which one was used.
async function loadGrantableSubscription(proof: GrantProof, subscriptionId: string) {
  if (!isSessionProof(proof)) {
    if (!verifyEmailToken(proof.email_token, proof.email)) return null;
    return loadOwnedSubscription(proof.email, subscriptionId);
  }

  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId: proof.session_id },
    select: { sessionToken: true, subscriptionId: true },
  });
  if (!session || session.sessionToken !== proof.session_token) return null;

  // The session may only speak for the subscription it actually created —
  // otherwise any completed session would be a key to every subscription.
  const sub = await prisma.subscription.findFirst({
    where: { subscriptionId },
    include: { plan: true, merchant: true, renewalDelegations: { where: { status: "active" } } },
  });
  if (!sub) return null;
  if (session.subscriptionId !== sub.id && session.subscriptionId !== sub.subscriptionId) return null;
  return sub;
}

// Load a subscription the proven email actually owns. Email is the global anchor
// (subscriberEmail), with a fallback to the email-anchored Customer relation.
async function loadOwnedSubscription(email: string, subscriptionId: string) {
  const normalized = normalizeEmail(email);
  return prisma.subscription.findFirst({
    where: {
      subscriptionId,
      OR: [{ subscriberEmail: normalized }, { customer: { is: { email: normalized } } }],
    },
    include: { plan: true, merchant: true, renewalDelegations: { where: { status: "active" } } },
  });
}

// ─── POST /customer/portal/subscriptions ──────────────────────────────────────
// List every non-cancelled subscription for the proven email, across all merchants.
customerPortalRouter.post("/subscriptions", async (req, res) => {
  const parsed = proofSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);
  const { email, email_token } = parsed.data;

  // Same non-enumerable shape whether the token is bad or the email has no subs.
  if (!verifyEmailToken(email_token, email)) return ok(res, { proven: false, subscriptions: [] });

  const normalized = normalizeEmail(email);
  try {
    const subs = await prisma.subscription.findMany({
      where: {
        status: { in: ["active", "trialing", "past_due"] },
        OR: [{ subscriberEmail: normalized }, { customer: { is: { email: normalized } } }],
      },
      include: {
        plan: true,
        merchant: { select: { name: true } },
        renewalDelegations: { where: { status: "active" } },
      },
      orderBy: { createdAt: "desc" },
    });

    return ok(res, {
      proven: true,
      email: normalized,
      subscriptions: subs.map((s) => {
        const amount = Number(s.amount ?? s.plan.amount);
        const interval = s.interval ?? s.plan.interval;
        const refundable =
          s.escrowBalance > 0n && !!s.settlementDeadline && s.settlementDeadline > new Date();
        return {
          id: s.subscriptionId,
          merchant: { name: s.merchant.name },
          status: s.status,
          wallet_address: s.walletAddress,
          plan: { name: s.plan.name, amount, interval, currency: s.plan.currency },
          current_period_end: s.currentPeriodEnd.toISOString(),
          trial_end: s.trialEnd ? s.trialEnd.toISOString() : null,
          escrow_refundable: refundable,
          refundable_until: refundable && s.settlementDeadline ? s.settlementDeadline.toISOString() : null,
          refundable_amount: refundable ? Number(s.escrowBalance) : 0,
          permissions: {
            arc_subscription: !!s.onChainSubId,
            cross_chain_grants: s.renewalDelegations.length,
          },
          // The chains themselves, so the portal can offer per-chain control
          // instead of one all-or-nothing switch. Status here is the stored one,
          // kept honest by the 01:30 reconciliation pass rather than read live —
          // a page load should not depend on three public RPCs answering.
          grants: s.renewalDelegations.map((d) => ({
            mandate_id: d.mandateId,
            chain_id: d.chainId,
            chain: chainKeyForId(d.chainId) ?? `chain-${d.chainId}`,
            period_amount: Number(d.periodAmount),
            expires_at: d.expiry.toISOString(),
          })),
          cross_chain_enabled: s.renewalDelegations.length > 0,
          revocable: !!s.onChainSubId || s.renewalDelegations.length > 0,
        };
      }),
    });
  } catch (e) {
    console.error("[portal/subscriptions]", e);
    return err(res, "Failed to load subscriptions", 500);
  }
});

// ─── POST /customer/portal/subscriptions/:id/cancel ───────────────────────────
// Full cancel: on-chain cancelSubscription (returns escrow) + revoke every grant.
customerPortalRouter.post("/subscriptions/:id/cancel", async (req, res) => {
  const parsed = proofSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);
  const { email, email_token } = parsed.data;
  if (!verifyEmailToken(email_token, email)) {
    return err(res, "Verify your email to manage this subscription.", 403);
  }

  const sub = await loadOwnedSubscription(email, req.params.id as string);
  if (!sub) return err(res, "Subscription not found", 404, "not_found");
  if (sub.status === "cancelled") return err(res, "This subscription is already cancelled", 409);

  try {
    const result = await revokeSubscription(sub, sub.merchant.merchantId, {
      reason: "cancelled_by_customer",
    });
    return ok(res, {
      id: sub.subscriptionId,
      status: "cancelled",
      refunded_escrow: Number(result.refundedEscrow),
      revoked_delegations: result.revokedDelegations,
      on_chain_cancelled: !result.onChainError,
      tx_hash: result.cancelTxHash,
    });
  } catch (e) {
    console.error("[portal/cancel]", e);
    return err(res, "Failed to cancel subscription", 500);
  }
});

// ─── POST /customer/portal/subscriptions/:id/grant-plan ────────────────────────
// Source chains the wallet can grant a cross-chain renewal mandate on for THIS
// subscription. Cap = the subscription's own period amount/interval.
const grantPlanSchema = z.intersection(grantProofSchema, z.object({ wallet: z.string().regex(ADDRESS_RE) }));

customerPortalRouter.post("/subscriptions/:id/grant-plan", async (req, res) => {
  const parsed = grantPlanSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);

  const sub = await loadGrantableSubscription(parsed.data, req.params.id as string);
  if (!sub) return err(res, "Subscription not found", 404, "not_found");
  if (sub.status === "cancelled") return err(res, "Subscription is cancelled", 409);

  try {
    const amount = sub.amount ?? sub.plan.amount;
    const interval = sub.interval ?? sub.plan.interval;
    const periodDuration = INTERVAL_SECONDS[interval] ?? INTERVAL_SECONDS.monthly;
    const delegate = getDelegateAddress();

    // Every supported source chain, regardless of current USDC balance — see
    // the equivalent checkout-side grant-plan in routes/delegation.ts.
    const targets = supportedSourceChains().map((src) => ({
      chain_id: src.chain.id,
      chain_key: src.key,
      name: src.name,
      token: src.usdc,
      period_amount: amount.toString(),
      period_duration: periodDuration,
      delegate,
    }));

    // Chains this subscription is already covered on. The checkout side has done
    // this from the start; this one did not, so re-enabling from the portal
    // minted a fresh on-chain delegation for every chain each time — including
    // ones already authorized. Nothing cleans those up: a disable costs the
    // subscriber gas and only their own wallet can send it, so every redundant
    // grant is permanent until they pay to remove it.
    const existing = await prisma.renewalDelegation.findMany({
      where: {
        subscriptionId: sub.id,
        status: "active",
        // Scoped to the wallet actually signing. A subscriber re-granting from a
        // different wallet holds none of the old one's authority, so those grants
        // are not coverage for them — without this they would be told they were
        // already authorized on a chain their current wallet cannot pay from.
        walletAddress: { equals: parsed.data.wallet, mode: "insensitive" },
      },
      select: { chainId: true, periodAmount: true, periodDuration: true },
    });
    const grantedChainIds = [
      ...new Set(
        existing.filter((g) => mandateCovers(g, amount, periodDuration)).map((g) => g.chainId)
      ),
    ];

    return ok(res, {
      targets,
      granted_chain_ids: grantedChainIds,
      already_enabled: targets.length > 0 && targets.every((t) => grantedChainIds.includes(t.chain_id)),
    });
  } catch (e) {
    console.error("[portal/grant-plan]", e);
    return err(res, "Failed to build grant plan", 500);
  }
});

// ─── POST /customer/portal/subscriptions/:id/grant ────────────────────────────
// Persist one granted ERC-7715 delegation, bound directly to the subscription.
const grantBodySchema = z.object({
  wallet_address: z.string().regex(ADDRESS_RE),
  account_address: z.string().regex(ADDRESS_RE).optional(),
  delegate_address: z.string().regex(ADDRESS_RE),
  chain_id: z.number().int().positive(),
  token: z.string().regex(ADDRESS_RE),
  delegation_manager: z.string().regex(ADDRESS_RE),
  context: z.string().regex(/^0x[a-fA-F0-9]+$/),
  dependencies: z
    .array(
      z.object({
        factory: z.string().regex(ADDRESS_RE),
        factoryData: z.string().regex(/^0x[a-fA-F0-9]*$/),
      })
    )
    .optional(),
  period_amount: z.string().regex(/^\d+$/),
  period_duration: z.number().int().positive(),
  expiry: z.number().int().nonnegative(),
});

const grantSchema = z.intersection(grantProofSchema, grantBodySchema);

customerPortalRouter.post("/subscriptions/:id/grant", async (req, res) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid grant", 400);
  const d = parsed.data;

  const sub = await loadGrantableSubscription(d, req.params.id as string);
  if (!sub) return err(res, "Subscription not found", 404, "not_found");
  if (sub.status === "cancelled") return err(res, "Subscription is cancelled", 409);

  try {
    // The signed context is the source of truth for the per-period cap — decode it
    // and persist THAT, rejecting a grant that can't cover one charge.
    const terms = decodePeriodTransferTerms(d.context as Hex, d.token as Address);
    if (!terms) {
      return err(res, `Delegation has no erc20 period-transfer permission for token ${d.token}`, 400);
    }
    const effectiveAmount = sub.amount ?? sub.plan.amount;
    if (terms.periodAmount < effectiveAmount) {
      return err(
        res,
        `Granted cap ${terms.periodAmount} is below the subscription price ${effectiveAmount} — renewals would be rejected`,
        400
      );
    }

    // See delegation.ts — identity travels with the context, on create and update.
    const identity = await delegationIdentity(
      d.chain_id,
      d.delegation_manager as Address,
      d.context as Hex
    );

    const data = {
      sessionId: null,
      subscriptionId: sub.id,
      salt: identity.salt,
      delegationHash: identity.delegationHash,
      merchantId: sub.merchantId,
      walletAddress: d.wallet_address,
      accountAddress: d.account_address ?? d.wallet_address,
      delegateAddress: d.delegate_address,
      chainId: d.chain_id,
      token: d.token,
      periodAmount: terms.periodAmount,
      periodDuration: terms.periodDuration,
      expiry: new Date((d.expiry || Math.floor(Date.now() / 1000) + MANDATE_FALLBACK_SEC) * 1000),
      delegationManager: d.delegation_manager,
      context: d.context,
      dependencies: d.dependencies ?? [],
      status: "active",
    };

    // Idempotent per (subscription, chain): re-granting a chain replaces its mandate.
    const existing = await prisma.renewalDelegation.findFirst({
      where: { subscriptionId: sub.id, chainId: d.chain_id, status: "active" },
    });
    // Create-only: a re-grant keeps the mandate's public id. See delegation.ts.
    const delegation = existing
      ? await prisma.renewalDelegation.update({ where: { id: existing.id }, data })
      : await prisma.renewalDelegation.create({
        data: { ...data, mandateId: ids.mandate(), grantId: ids.grant() },
      });

    return ok(res, { delegation_id: delegation.id, status: delegation.status });
  } catch (e) {
    console.error("[portal/grant]", e);
    return err(res, "Failed to store renewal mandate", 500);
  }
});

// ─── POST /customer/portal/subscriptions/:id/grant-revoke ─────────────────────
// Turn OFF cross-chain renewals — the subscription stays active and keeps billing
// on Arc. Marks delegations revoked so the relayer's cross-chain pass can never
// redeem them.
//
// This is a SWEEP-SIDE revoke and cannot be anything else: disableDelegation on
// the DelegationManager is onlyDeleGator, so only the subscriber's own wallet can
// remove the signed permission. The portal copy says so rather than implying the
// authorization is gone.
const grantRevokeSchema = proofSchema.extend({
  // One chain, or every chain when omitted. Grants are stored one row per chain,
  // so scoping leaves the others untouched — mirroring the checkout undo.
  chain_id: z.number().int().positive().optional(),
});

customerPortalRouter.post("/subscriptions/:id/grant-revoke", async (req, res) => {
  const parsed = grantRevokeSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);
  const { email, email_token, chain_id } = parsed.data;
  if (!verifyEmailToken(email_token, email)) return err(res, "Verify your email first.", 403);

  const sub = await loadOwnedSubscription(email, req.params.id as string);
  if (!sub) return err(res, "Subscription not found", 404, "not_found");

  try {
    const result = await prisma.renewalDelegation.updateMany({
      where: {
        subscriptionId: sub.id,
        status: "active",
        ...(chain_id !== undefined ? { chainId: chain_id } : {}),
      },
      data: { status: "revoked" },
    });
    return ok(res, { revoked: result.count });
  } catch (e) {
    console.error("[portal/grant-revoke]", e);
    return err(res, "Failed to revoke cross-chain grant", 500);
  }
});
