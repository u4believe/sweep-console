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
import { ok, err, serverError } from "../lib/response";
import { fireWebhook } from "../lib/webhooks/delivery";
import { ids } from "../lib/ids";
import { verifyEmailToken, normalizeEmail } from "../lib/checkout/identity";
import { revokeSubscription } from "../lib/subscriptions/revoke";
import { supportedSourceChains, chainKeyForId } from "../lib/gateway/chains";
import { getDelegateAddress, decodePeriodTransferTerms, delegationIdentity, mandateCovers } from "../lib/chain/delegation";
import { getSettlementAddress, settlementIsSeparate } from "../lib/chain/signers";
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
        // What a subscriber actually came here to check: was I charged, when,
        // and can I verify it. Capped — the portal shows a history, not a ledger,
        // and a yearly subscriber five years in does not need all of it on load.
        payments: {
          orderBy: { createdAt: "desc" },
          take: 12,
          select: {
            paymentId: true, amount: true, currency: true, status: true,
            type: true, chain: true, txHash: true, createdAt: true, failureReason: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Rail mandates belonging to the same proved address.
    //
    // A rail payer is not a Subscription — the developer owns the schedule and
    // Sweep only executes it — so none of these ever appeared here, and a payer
    // whose wallet was being charged every month could find no record of it on
    // the platform doing the charging. Matched through the Customer the OTP
    // step links, which is the only email on a mandate that was ever proved;
    // Mandate.email on its own is the developer's assertion.
    const mandates = await prisma.mandate.findMany({
      where: {
        status: { in: ["pending", "active"] },
        // Either proof of who the payer is. The Customer link is written by
        // /complete and verifiedEmail by the OTP step before it, so a mandate
        // whose link failed is still reachable by the address its payer proved.
        //
        // Deliberately NOT the developer's `email`: they assert that one, and
        // matching it would put a mandate — merchant, amount, signing wallet —
        // in the inbox of anyone they name, proved or not.
        OR: [
          { customer: { is: { email: normalized } } },
          { verifiedEmail: normalized },
        ],
      },
      include: {
        merchant: { select: { name: true } },
        charges: {
          orderBy: { createdAt: "desc" },
          take: 6,
          select: {
            chargeId: true, amount: true, currency: true, status: true,
            chain: true, txHash: true, createdAt: true, failureReason: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // The grants are keyed by mandateId rather than related, so they come
    // separately and are stitched below.
    const mandateGrants = mandates.length
      ? await prisma.renewalDelegation.findMany({
          where: {
            status: "active",
            mode: "external",
            sessionId: { in: mandates.map((m) => m.mandateId) },
          },
          select: { sessionId: true, chainId: true, periodAmount: true },
        })
      : [];

    return ok(res, {
      proven: true,
      mandates: mandates.map((m) => ({
        mandate_id: m.mandateId,
        merchant: { name: m.merchant.name },
        max_amount: Number(m.maxAmount),
        currency: "USDC",
        interval: m.interval,
        status: m.status,
        wallet_address: m.walletAddress,
        expires_at: m.expiresAt.toISOString(),
        authorized_at: m.authorizedAt?.toISOString() ?? null,
        test_mode: m.isTestMode,
        chains: mandateGrants
          .filter((g) => g.sessionId === m.mandateId)
          .map((g) => ({ chain_id: g.chainId, period_amount: Number(g.periodAmount) })),
        charges: m.charges.map((c) => ({
          charge_id: c.chargeId,
          amount: Number(c.amount),
          currency: c.currency,
          status: c.status,
          chain: c.chain,
          tx_hash: c.txHash,
          created_at: c.createdAt.toISOString(),
          failure_reason: c.failureReason,
        })),
      })),
      email: normalized,
      // Every chain a subscription COULD be authorized on. The portal lists all
      // of them with their state; without this it could only render the ones
      // already granted, which is the half that needs no action.
      supported_chains: supportedSourceChains().map((c) => ({
        chain_id: c.chain.id,
        chain_key: c.key,
        name: c.name,
      })),
      subscriptions: subs.map((s) => {
        const amount = Number(s.amount ?? s.plan.amount);
        const interval = s.interval ?? s.plan.interval;
        return {
          id: s.subscriptionId,
          merchant: { name: s.merchant.name },
          status: s.status,
          wallet_address: s.walletAddress,
          plan: { name: s.plan.name, amount, interval, currency: s.plan.currency },
          created_at: s.createdAt.toISOString(),
          current_period_end: s.currentPeriodEnd.toISOString(),
          trial_end: s.trialEnd ? s.trialEnd.toISOString() : null,
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
          // `chain` is where the payment SETTLED, which for every renewal is Arc.
          // It is not where the money came from — that is decided per charge and
          // is not recorded on the row — so the portal labels this column for
          // what it holds rather than implying a source.
          payments: s.payments.map((p) => ({
            id: p.paymentId,
            amount: Number(p.amount),
            currency: p.currency,
            status: p.status,
            type: p.type,
            settled_on: p.chain,
            tx_hash: p.txHash,
            failure_reason: p.failureReason,
            created_at: p.createdAt.toISOString(),
          })),
        };
      }),
    });
  } catch (e) {
    return serverError(res, "portal/subscriptions", e, "We couldn't load your subscriptions.");
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
      revoked_delegations: result.revokedDelegations,
    });
  } catch (e) {
    return serverError(res, "portal/cancel", e, "We couldn't cancel that subscription.");
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
  // Only pin a payee when settlement is genuinely a different key. Pinning it to
  // an address the delegate already controls constrains nothing — a thief redeems
  // into it and spends from it with the same key — and would leave a caveat in the
  // signed context implying a protection that is not there.
  const payee = settlementIsSeparate() ? getSettlementAddress() : undefined;

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
      payee,
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
    return serverError(res, "portal/grant-plan", e, "We couldn't work out how to collect this payment.");
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

  // A grant has to come from the wallet this subscription pays from.
  //
  // Both portal buttons check this before prompting, but the check that counts
  // is this one: proof here is an email OTP, which says who the subscriber is
  // and nothing about which wallet signed. A grant from a different wallet is
  // taken by the update path below as a replacement for the right one — same
  // subscription, same chain — so the row that names who funds this
  // subscription is quietly rewritten.
  //
  // The renewal pass would then disagree with itself: selectPaymentChain reads
  // sub.walletAddress to decide whether there is enough USDC, while the redeem
  // spends the context, which is signed by the other wallet. It would weigh one
  // wallet's balance and pull from another's.
  if (sub.walletAddress.toLowerCase() !== d.wallet_address.toLowerCase()) {
    return err(
      res,
      `This subscription pays from ${sub.walletAddress}. Authorize from that wallet — ` +
        `only the wallet that signed up can approve charges for it.`,
      409,
      "wallet_mismatch"
    );
  }

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
    return serverError(res, "portal/grant", e, "We couldn't save your renewal permission.");
  }
});

// ─── POST /customer/portal/mandates/:id/revoke ────────────────────────────────
//
// The payer stopping a rail authorization themselves.
//
// Until this existed the only way out was the developer's own DELETE
// /v1/mandates/:id, or disabling the delegation in the wallet — so a payer who
// wanted a standing debit to stop had to ask the party being paid, or go
// on-chain. The portal showed them the authorization and offered nothing.
//
// Scoped through the Customer the OTP step links, so a payer can only end an
// authorization that is demonstrably theirs: the proved email is the key, not
// the mandate id, which is a developer's identifier and not a secret.
//
// Like every revoke on this platform it is a decision we record and honour,
// not a cryptographic one — disableDelegation is onlyDeleGator, so the signed
// permission stays in their wallet and only they can remove it there. What
// this guarantees is that Sweep will not redeem it.
const mandateRevokeSchema = proofSchema;

customerPortalRouter.post("/mandates/:id/revoke", async (req, res) => {
  const parsed = mandateRevokeSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid payload", 422);
  const { email, email_token } = parsed.data;
  if (!verifyEmailToken(email_token, email)) return err(res, "Verify your email first.", 403);

  const normalized = normalizeEmail(email);
  const mandate = await prisma.mandate.findFirst({
    where: {
      mandateId: req.params.id as string,
      // Same two proofs the list uses. They must agree, or the portal shows a
      // Cancel that 404s.
      OR: [
        { customer: { is: { email: normalized } } },
        { verifiedEmail: normalized },
      ],
    },
    select: {
      id: true, mandateId: true, externalRef: true, status: true,
      walletAddress: true, merchantId: true, merchant: { select: { merchantId: true } },
    },
  });
  if (!mandate) return err(res, "Authorization not found", 404, "not_found");

  // Idempotent, for the same reason the developer's revoke is: a second tap on
  // a slow button is not an error.
  if (mandate.status === "revoked") {
    return ok(res, { mandate_id: mandate.mandateId, status: "revoked" });
  }

  try {
    const revokedAt = new Date();
    await prisma.$transaction([
      prisma.mandate.update({
        where: { id: mandate.id },
        data: { status: "revoked", revokedAt },
      }),
      // The grants go too. A charge is refused on the mandate's status alone,
      // but leaving them active would leave rows claiming to be redeemable that
      // nothing will ever redeem — the orphan problem in a different costume.
      prisma.renewalDelegation.updateMany({
        where: { sessionId: mandate.mandateId, mode: "external", status: "active" },
        data: { status: "revoked" },
      }),
    ]);

    // The developer finds out now rather than at their next refused charge.
    // revoked_by is the point of this event for them: their own DELETE and
    // their payer walking away need different handling, and without it the two
    // are indistinguishable.
    void fireWebhook(
      mandate.merchantId,
      mandate.externalRef,
      mandate.merchant.merchantId,
      "mandate.revoked",
      {
        mandate_id: mandate.mandateId,
        external_ref: mandate.externalRef,
        wallet_address: mandate.walletAddress,
        revoked_at: revokedAt.toISOString(),
        revoked_by: "payer",
        on_chain: false,
      }
    ).catch((e: unknown) => console.error("[portal/mandate-revoke] webhook failed:", e));

    console.log(`[portal/mandate-revoke] ${mandate.mandateId} revoked by its payer`);
    return ok(res, { mandate_id: mandate.mandateId, status: "revoked" });
  } catch (e) {
    return serverError(res, "portal/mandate-revoke", e, "We couldn't turn that off. Try again.");
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

    // Revoking the LAST chain ends the subscription's ability to bill, and that
    // has to be recorded. runDelegatedRenewalsOnce starts its query from active
    // grants, so a subscription with none is not "failing" — it is invisible: it
    // would sit "active" forever, never charged, never retried, never past_due,
    // with the creator serving someone for free and neither party told. Marking
    // it past_due puts it back in front of the dunning that already exists, which
    // retries, emails, and finally cancels.
    const remaining = await prisma.renewalDelegation.count({
      where: { subscriptionId: sub.id, status: "active" },
    });
    let status = sub.status;
    if (remaining === 0 && (sub.status === "active" || sub.status === "trialing")) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: "past_due" },
      });
      status = "past_due";
      console.log(
        `[portal/grant-revoke] ${sub.subscriptionId} has no chains left — past_due so dunning can pick it up`
      );
    }

    return ok(res, { revoked: result.count, remaining_chains: remaining, status });
  } catch (e) {
    return serverError(res, "portal/grant-revoke", e, "We couldn't revoke that permission.");
  }
});
