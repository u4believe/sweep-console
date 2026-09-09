// The subscriber-facing side of the external rail: /authorize/:mandate_id.
//
// Unauthenticated by design — the subscriber has no Sweep account and never will.
// The mandate id in the link is the credential, exactly as the checkout session id
// is, and mutations additionally carry the session_token the GET hands back. That
// is the same trust model checkout already runs on: whoever holds the link can act
// on it, which is why linkExpiresAt is short and separate from the mandate's own
// expiry.
//
// Risk 03 from the design lives here. On hosted checkout, Sweep shows the
// subscriber exactly what they agree to. On the rail, Sweep executes charges for
// terms it never set — so this page is the only place a person sees the ceiling
// and the period before signing, and nothing downstream re-confirms it. Every
// field the page needs to say that plainly is returned below.

import { Router } from "express";
import { z } from "zod";
import type { Address, Hex } from "viem";
import { prisma } from "../lib/prisma";
import { ids } from "../lib/ids";
import { ok, err } from "../lib/response";
import { decodePeriodTransferTerms, delegationIdentity } from "../lib/chain/delegation";
import { getRelayerAddress } from "../lib/chain/signers";
import { supportedSourceChains } from "../lib/gateway/chains";
import { fireWebhook } from "../lib/webhooks/delivery";

export const authorizeRouter = Router();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

interface MandateForPage {
  id: string;
  mandateId: string;
  externalRef: string;
  email: string | null;
  walletAddress: string | null;
  maxAmount: bigint;
  interval: string;
  periodDuration: number;
  chains: string[];
  status: string;
  expiresAt: Date;
  linkExpiresAt: Date;
  returnUrl: string | null;
  sessionToken: string;
  merchantId: string;
  merchant: { name: string; merchantId: string };
}

/// The chains this mandate can actually be granted on, as the grant loop wants
/// them.
///
/// ARC IS NOT ONE OF THEM, and cannot be. Arc holds the SubscriptionManager, so
/// recurring authority there is an ERC-2612 permit granting a USDC allowance TO
/// THAT CONTRACT, which the platform draws against as the arbiter — see
/// lib/subscriptions/allowance.ts and the header of DelegatedRenewalToggle
/// ("Arc needs no grant at all; it rides the ERC-2612 permit"). ERC-7715
/// delegation is the off-Arc mechanism: a 7702 smart account per source chain,
/// redeemed by the relayer and bridged over. A wallet asked for a 7715
/// permission on Arc simply refuses, which is correct behaviour and not a bug to
/// route around.
///
/// The rail therefore cannot charge on Arc today: the manager's charge path is
/// shaped around a Subscription, and a mandate has none. Arc mandates are
/// rejected at creation; this stays defensive for rows created before that.
function targetsFor(m: MandateForPage) {
  const sources = supportedSourceChains();
  const delegate = getRelayerAddress("external");
  const targets: {
    chain_id: number;
    chain_key: string;
    name: string;
    token: string;
    period_amount: string;
    period_duration: number;
    delegate: string;
  }[] = [];
  // A chain the developer asked for that this deployment can no longer offer.
  // Returned rather than quietly dropped: a mandate created for three chains and
  // signed on two is a discrepancy the developer must be able to see, and the
  // subscriber should not be left wondering where a network went.
  const unavailable: string[] = [];

  for (const key of m.chains) {
    const c = sources.find((s) => s.key === key);
    if (!c) {
      unavailable.push(key);
      continue;
    }
    targets.push({
      chain_id: c.chain.id,
      chain_key: c.key,
      name: c.chain.name,
      token: c.usdc,
      period_amount: m.maxAmount.toString(),
      period_duration: m.periodDuration,
      delegate,
    });
  }
  return { targets, unavailable };
}

async function loadMandate(mandateId: string) {
  return prisma.mandate.findUnique({
    where: { mandateId },
    select: {
      id: true, mandateId: true, externalRef: true, email: true, walletAddress: true,
      maxAmount: true, interval: true, periodDuration: true, chains: true,
      status: true, expiresAt: true, linkExpiresAt: true, returnUrl: true,
      sessionToken: true, merchantId: true,
      merchant: { select: { name: true, merchantId: true } },
    },
  });
}

/// Grants belonging to this mandate. They are bound by sessionId holding the
/// mandate's public id — the same way checkout binds grants to a session before
/// the Subscription exists. A real FK replaces this in the contract step, once
/// RenewalDelegation.mandateId is freed from its legacy public id.
function grantsWhere(mandateId: string) {
  return { sessionId: mandateId, mode: "external" as const };
}

// ─── GET /authorize/:mandate_id ───────────────────────────────────────────────
authorizeRouter.get("/authorize/:mandate_id", async (req, res) => {
  const m = await loadMandate(req.params.mandate_id as string);
  if (!m) return err(res, "Authorization not found", 404, "not_found");

  const grants = await prisma.renewalDelegation.findMany({
    where: { ...grantsWhere(m.mandateId), status: "active" },
    select: { chainId: true, grantId: true },
  });

  const { targets, unavailable } = targetsFor(m);
  const linkExpired = m.linkExpiresAt.getTime() < Date.now();
  const mandateExpired = m.expiresAt.getTime() < Date.now();

  return ok(res, {
    id: m.mandateId,
    status: mandateExpired && m.status === "pending" ? "expired" : m.status,
    // Everything a person needs to judge what they are agreeing to, in the words
    // the page shows. The merchant NAME matters most: it is the only party the
    // subscriber recognises, and Sweep is merely executing on its instruction.
    merchant_name: m.merchant.name,
    email: m.email,
    max_amount: Number(m.maxAmount),
    currency: "USDC",
    interval: m.interval,
    period_duration: m.periodDuration,
    expires_at: m.expiresAt.toISOString(),
    // Two different clocks, and conflating them is how a subscriber gets a dead
    // link and blames the merchant.
    link_expires_at: m.linkExpiresAt.toISOString(),
    link_expired: linkExpired,
    wallet_address: m.walletAddress,
    return_url: m.returnUrl,
    session_token: m.sessionToken,
    targets,
    unavailable_chains: unavailable,
    granted_chain_ids: [...new Set(grants.map((g) => g.chainId))],
  });
});

const grantSchema = z.object({
  session_token: z.string().min(1),
  wallet_address: z.string().regex(ADDRESS_RE),
  account_address: z.string().regex(ADDRESS_RE).optional(),
  delegate_address: z.string().regex(ADDRESS_RE),
  chain_id: z.number().int().positive(),
  token: z.string().regex(ADDRESS_RE),
  delegation_manager: z.string().regex(ADDRESS_RE),
  context: z.string().regex(/^0x[a-fA-F0-9]+$/),
  dependencies: z
    .array(z.object({ factory: z.string().regex(ADDRESS_RE), factoryData: z.string().regex(/^0x[a-fA-F0-9]*$/) }))
    .optional(),
  period_amount: z.string().regex(/^\d+$/),
  period_duration: z.number().int().positive(),
  expiry: z.number().int().nonnegative(),
});

// ─── POST /authorize/:mandate_id/grant ────────────────────────────────────────
//
// Persist one chain's signed permission. Called once per chain by the wallet loop,
// which deliberately keeps going when a single chain fails.
authorizeRouter.post("/authorize/:mandate_id/grant", async (req, res) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid delegation grant", 422);
  const d = parsed.data;

  try {
    const m = await loadMandate(req.params.mandate_id as string);
    if (!m) return err(res, "Authorization not found", 404, "not_found");
    if (m.sessionToken !== d.session_token) return err(res, "Invalid session token", 401);
    if (m.linkExpiresAt.getTime() < Date.now()) {
      return err(res, "This authorization link has expired. Ask the merchant for a new one.", 410, "link_expired");
    }
    if (m.status === "revoked") return err(res, "This authorization was revoked", 409, "mandate_revoked");
    if (m.expiresAt.getTime() < Date.now()) return err(res, "This authorization has expired", 409, "mandate_expired");

    // The signed context is the source of truth for the cap, not the client's
    // period_amount — persist what the wallet actually authorized. A grant whose
    // cap is below the mandate's ceiling is kept, not rejected: it simply means
    // charges above it will fail, which is the subscriber's prerogative.
    const terms = decodePeriodTransferTerms(d.context as Hex, d.token as Address);
    if (!terms) {
      return err(res, `Delegation has no erc20 period-transfer permission for token ${d.token}`, 422);
    }
    if (terms.periodDuration !== m.periodDuration) {
      return err(
        res,
        `Granted period ${terms.periodDuration}s does not match the mandate's ${m.periodDuration}s`,
        422,
        "period_mismatch"
      );
    }

    const identity = await delegationIdentity(d.chain_id, d.delegation_manager as Address, d.context as Hex);

    const data = {
      // Binds the grant to this mandate until the FK exists. See grantsWhere().
      sessionId: m.mandateId,
      mode: "external",
      merchantId: m.merchantId,
      externalRef: m.externalRef,
      salt: identity.salt,
      delegationHash: identity.delegationHash,
      walletAddress: d.wallet_address,
      accountAddress: d.account_address ?? d.wallet_address,
      delegateAddress: d.delegate_address,
      chainId: d.chain_id,
      token: d.token,
      periodAmount: terms.periodAmount,
      periodDuration: terms.periodDuration,
      expiry: new Date((d.expiry || Math.floor(m.expiresAt.getTime() / 1000)) * 1000),
      delegationManager: d.delegation_manager,
      context: d.context,
      dependencies: d.dependencies ?? [],
      status: "active",
    };

    // Idempotent per (mandate, chain): re-signing a chain replaces its grant
    // rather than stacking a second redeemable permission on the same wallet.
    const existing = await prisma.renewalDelegation.findFirst({
      where: { ...grantsWhere(m.mandateId), chainId: d.chain_id, status: "active" },
    });
    const grant = existing
      ? await prisma.renewalDelegation.update({ where: { id: existing.id }, data })
      : await prisma.renewalDelegation.create({
        data: { ...data, mandateId: ids.mandate(), grantId: ids.grant() },
      });

    return ok(res, { grant_id: grant.grantId, chain_id: grant.chainId, status: grant.status });
  } catch (e) {
    console.error("[authorize/grant]", e);
    return err(res, "Failed to store the authorization", 500);
  }
});

const completeSchema = z.object({
  session_token: z.string().min(1),
  wallet_address: z.string().regex(ADDRESS_RE),
});

// ─── POST /authorize/:mandate_id/complete ─────────────────────────────────────
//
// Flips the mandate to active once at least one chain is signed, and tells the
// developer. Separate from /grant because a subscriber may sign several chains
// and we only want one event.
authorizeRouter.post("/authorize/:mandate_id/complete", async (req, res) => {
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Invalid request", 422);
  const d = parsed.data;

  try {
    const m = await loadMandate(req.params.mandate_id as string);
    if (!m) return err(res, "Authorization not found", 404, "not_found");
    if (m.sessionToken !== d.session_token) return err(res, "Invalid session token", 401);
    if (m.status === "revoked") return err(res, "This authorization was revoked", 409, "mandate_revoked");

    const grants = await prisma.renewalDelegation.findMany({
      where: { ...grantsWhere(m.mandateId), status: "active" },
      select: { chainId: true, grantId: true },
    });
    if (grants.length === 0) {
      return err(res, "No chain has been authorized yet", 409, "no_grants");
    }

    // Already active — a double submit, or the subscriber adding a chain later.
    // Return the current state rather than firing the event twice.
    if (m.status === "active") {
      return ok(res, { id: m.mandateId, status: "active", chain_ids: grants.map((g) => g.chainId) });
    }

    const updated = await prisma.mandate.update({
      where: { id: m.id },
      data: { status: "active", walletAddress: d.wallet_address, authorizedAt: new Date() },
      select: { mandateId: true, status: true, maxAmount: true, interval: true, expiresAt: true },
    });

    await fireWebhook(m.merchantId, m.externalRef, m.merchant.merchantId, "mandate.authorized", {
      mandate_id: updated.mandateId,
      external_ref: m.externalRef,
      wallet_address: d.wallet_address,
      max_amount: Number(updated.maxAmount),
      currency: "USDC",
      interval: updated.interval,
      chain_ids: grants.map((g) => g.chainId),
      expires_at: updated.expiresAt.toISOString(),
    }).catch((e) => console.error("[authorize/complete] webhook failed:", e));

    return ok(res, { id: updated.mandateId, status: updated.status, chain_ids: grants.map((g) => g.chainId) });
  } catch (e) {
    console.error("[authorize/complete]", e);
    return err(res, "Failed to complete the authorization", 500);
  }
});
