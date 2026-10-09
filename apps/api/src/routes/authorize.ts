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
import { ok, err, serverError } from "../lib/response";
import { decodePeriodTransferTerms, delegationIdentity } from "../lib/chain/delegation";
import { getRelayerAddress, getSettlementAddress, settlementIsSeparate } from "../lib/chain/signers";
import { supportedSourceChains } from "../lib/gateway/chains";
import { fireWebhook } from "../lib/webhooks/delivery";
import {
  requestEmailOtp,
  verifyEmailOtp,
  verifyEmailToken,
  normalizeEmail,
  resolveCheckoutCustomer,
  issueEmailToken,
  OtpError,
} from "../lib/checkout/identity";

export const authorizeRouter = Router();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

interface MandateForPage {
  id: string;
  mandateId: string;
  externalRef: string;
  email: string | null;
  emailVerifiedAt: Date | null;
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
/// ARC IS NOT ONE OF THEM — but not for the reason this comment used to give.
///
/// The old reason was the SubscriptionManager: recurring authority on Arc was an
/// ERC-2612 permit to that contract, drawn by the platform as arbiter. That
/// contract is retired and paused, lib/subscriptions/allowance.ts is gone, and
/// nothing of ours is called on any chain. The conclusion outlived its reasons.
///
/// The real reason, established by attempting it on 2026-10-05:
///
///   MetaMask will not sign a delegation for an account on Arc. The request is
///   refused with "External signature requests cannot sign delegations for
///   internal accounts" — it does not treat the account as a smart account on
///   that chain, so there is no delegator to sign.
///
/// Everything else is in place, which is why this is worth revisiting rather
/// than assuming settled. Arc accepts EIP-7702 and the account upgrades to the
/// SAME implementation as every source chain (0x63c0c19a…E32B). The
/// DelegationManager and all four enforcers ARE deployed on Arc at the canonical
/// addresses. The blocker is wallet-side support, not the chain and not us.
///
/// The reliable predictor is the kit's own registry: getSmartAccountsEnvironment
/// throws "No contracts found for version 1.3.0 chain 5042002" for Arc, and
/// returns an environment for Base, Arbitrum and OP Sepolia — which is exactly
/// the set where granting works. apps/web/src/lib/delegation/upgrade.ts exports
/// supportsDelegation() for that check; it now runs BEFORE the 7702 prompt, so a
/// subscriber on an unsupported chain is told rather than charged gas for an
/// upgrade whose grant is then refused.
///
/// Do NOT read support off the wallet's getSupportedExecutionPermissions() chain
/// list. It returns the same 43 chains for every permission type, Arc included,
/// and so describes chains MetaMask knows rather than chains where a delegation
/// can be signed. That list is what first suggested Arc would work.
///
/// If MetaMask ships the framework for Arc, the settlement path already exists:
/// delegated-renewal.ts handles chosenKey === "arc" by transferring the merchant
/// share to the creator and the fee to the treasury directly — no bridge, and no
/// relayer custody at all. Arc mandates are rejected at creation; this stays
/// defensive for rows created before that.
function targetsFor(m: MandateForPage) {
  const sources = supportedSourceChains();
  const delegate = getRelayerAddress("external");
  // Where a redemption may pay out. Pinned into the signed context as a
  // payee rule, so a delegate key alone cannot send a subscriber\'s USDC
  // anywhere else — see lib/chain/signers.ts settlementIsSeparate().
  // Only pin a payee when settlement is genuinely a different key. Pinning it to
  // an address the delegate already controls constrains nothing — a thief redeems
  // into it and spends from it with the same key — and would leave a caveat in the
  // signed context implying a protection that is not there.
  const payee = settlementIsSeparate() ? getSettlementAddress() : undefined;
  const targets: {
    chain_id: number;
    chain_key: string;
    name: string;
    token: string;
    period_amount: string;
    period_duration: number;
    delegate: string;
    payee?: string;
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
      payee,
    });
  }
  return { targets, unavailable };
}

async function loadMandate(mandateId: string) {
  return prisma.mandate.findUnique({
    where: { mandateId },
    select: {
      id: true, mandateId: true, externalRef: true, email: true, emailVerifiedAt: true,
      walletAddress: true,
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
    // Whether that address still has to be proved, and whether the payer may
    // choose it. A developer-supplied address is the one the merchant believes
    // it is billing, so the page shows it locked.
    email_verified: !!m.emailVerifiedAt,
    email_locked: !!m.email,
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

// ─── Proving who the payer is ─────────────────────────────────────────────────
//
// Mandate.email is whatever the developer passed — its own schema comment says
// it is "not proof of anything". Until this existed the rail never asked the
// payer anything: they connected a wallet, signed, and the platform recorded an
// address and a developer's assertion. Nothing tied the payment to a person who
// had agreed to it, so a rail payer existed in no portal and could be sent
// someone else's receipt.
//
// Same OTP the hosted checkout uses, so a payer who is already a Customer at
// this merchant resolves to that same Customer rather than a second one.
//
// When the developer DID supply an email, that is the address the merchant
// believes it is billing, so it is the address that must be proved. Letting the
// payer verify a different one would reintroduce the drift from the other side.
const otpSchema = z.object({
  session_token: z.string().min(1),
  email: z.string().email(),
});
const otpVerifySchema = otpSchema.extend({ code: z.string().min(4).max(12) });

/// Shared gate: a live link, an unrevoked mandate, and the right session token.
interface OtpGateError {
  message: string;
  status: number;
  code?: string;
}

async function loadForOtp(
  mandateId: string,
  sessionToken: string
): Promise<{ m: MandateForPage; error?: undefined } | { m?: undefined; error: OtpGateError }> {
  const m = await loadMandate(mandateId);
  if (!m) return { error: { message: "Authorization not found", status: 404, code: "not_found" } };
  if (m.sessionToken !== sessionToken) {
    return { error: { message: "Invalid session token", status: 401 } };
  }
  if (m.linkExpiresAt.getTime() < Date.now()) {
    return {
      error: {
        message: "This authorization link has expired. Ask the merchant for a new one.",
        status: 410,
        code: "link_expired",
      },
    };
  }
  if (m.status === "revoked") {
    return { error: { message: "This authorization was revoked", status: 409, code: "mandate_revoked" } };
  }
  return { m };
}

/// The address this mandate may be verified against: the developer's if they
/// named one, otherwise whatever the payer enters.
function emailMismatch(m: { email: string | null }, email: string): boolean {
  return !!m.email && normalizeEmail(m.email) !== normalizeEmail(email);
}

authorizeRouter.post("/authorize/:mandate_id/otp", async (req, res) => {
  const parsed = otpSchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Enter a valid email address", 422);
  const { session_token, email } = parsed.data;

  const loaded = await loadForOtp(req.params.mandate_id as string, session_token);
  if (loaded.error) return err(res, loaded.error.message, loaded.error.status, loaded.error.code);
  const m = loaded.m;
  if (emailMismatch(m, email)) {
    return err(res, `This authorization is for ${m.email}. Use that address.`, 409, "email_mismatch");
  }

  try {
    await requestEmailOtp(email, m.merchant.name);
    return ok(res, { sent: true });
  } catch (e) {
    return serverError(res, "authorize/otp", e, "We couldn't send your code. Try again.");
  }
});

authorizeRouter.post("/authorize/:mandate_id/otp/verify", async (req, res) => {
  const parsed = otpVerifySchema.safeParse(req.body);
  if (!parsed.success) return err(res, "Enter the 6-digit code", 422);
  const { session_token, email, code } = parsed.data;

  const loaded = await loadForOtp(req.params.mandate_id as string, session_token);
  if (loaded.error) return err(res, loaded.error.message, loaded.error.status, loaded.error.code);
  const m = loaded.m;
  if (emailMismatch(m, email)) {
    return err(res, `This authorization is for ${m.email}. Use that address.`, 409, "email_mismatch");
  }

  try {
    const emailToken = await verifyEmailOtp(email, code);
    // Recorded here, not at completion: the proof is a fact about the payer the
    // moment it happens, and /grant below reads it rather than re-trusting a
    // token the client hands back.
    await prisma.mandate.update({
      where: { id: m.id },
      data: { email: normalizeEmail(email), emailVerifiedAt: new Date() },
    });
    return ok(res, { email_token: emailToken, email: normalizeEmail(email) });
  } catch (e) {
    if (e instanceof OtpError) return err(res, e.message, e.httpStatus, "otp_invalid");
    return serverError(res, "authorize/otp-verify", e, "We couldn't check your code. Try again.");
  }
});

const grantSchema = z.object({
  session_token: z.string().min(1),
  // Proof from /otp/verify. Checked against the address stored on the mandate.
  email_token: z.string().min(1),
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

    // No signature without a proved email.
    //
    // Both halves are checked. The stored timestamp is the server's own record
    // that this mandate was verified, and the token proves the caller is the
    // one who did it — a mandate verified in someone else's browser is not
    // authority for this request.
    if (!m.emailVerifiedAt || !m.email) {
      return err(res, "Verify your email before authorizing.", 403, "email_unverified");
    }
    if (!verifyEmailToken(d.email_token, m.email)) {
      return err(res, "Verify your email before authorizing.", 403, "email_unverified");
    }

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
    return serverError(res, "authorize/grant", e, "We couldn't save your authorization.");
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

    // The wallet is only known now, so this is where the proved email and the
    // address that signed become one Customer. Same resolver the hosted
    // checkout uses, so a payer who already bought from this merchant resolves
    // to the Customer they already are rather than a second row with the same
    // address on it.
    //
    // Best effort: the mandate is authorized either way. Failing the
    // authorization over a bookkeeping row would cost the payer a signature
    // they already gave.
    let customerDbId: string | null = null;
    if (m.email && m.emailVerifiedAt) {
      try {
        const resolved = await resolveCheckoutCustomer({
          merchantId: m.merchantId,
          walletAddress: d.wallet_address,
          email: m.email,
          emailToken: issueEmailToken(m.email),
        });
        customerDbId = resolved?.customerDbId ?? null;
      } catch (e) {
        console.error(`[authorize/complete] customer link failed for ${m.mandateId}:`, e);
      }
    }

    const updated = await prisma.mandate.update({
      where: { id: m.id },
      data: {
        status: "active",
        walletAddress: d.wallet_address,
        authorizedAt: new Date(),
        ...(customerDbId ? { customerId: customerDbId } : {}),
      },
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
    return serverError(res, "authorize/complete", e, "We couldn't finish your authorization.");
  }
});
