// Executing one charge against a mandate — the external rail's money path.
//
// It reuses the renewal path's machinery wholesale and introduces no new chain
// code: selectPaymentChain to find a funded chain, decodePeriodTransferTerms for
// the cap, redeemPeriodicTransfer to pull, BridgeTransfer for resumability, and
// advanceBridge to burn/attest/mint. What differs is only what "settled" means.
//
// Every charge is cross-chain. Arc cannot back a mandate — recurring authority
// there is an ERC-2612 permit to the SubscriptionManager, not a wallet permission
// this rail can redeem — so there is no synchronous case and no fast path. That
// is why POST /v1/charges answers 202 and settles by webhook.
//
// The fee is taken exactly as renewals take it: pull the full amount, bridge only
// the merchant's share, and leave the platform's cut in the relayer's source-chain
// balance. Retaining it first means a later failure cannot cost the platform its
// fee — and it means revenue accrues off-Arc and needs sweeping.
//
// ORDER MATTERS HERE. Funds move at redeemPeriodicTransfer, and from that instant
// the BridgeTransfer owns the period: failures resume, they never re-pull. The row
// is therefore written BEFORE the burn, exactly as the renewal path does it.

import type { Address, Hex } from "viem";
import { prisma } from "../lib/prisma";
import { selectPaymentChain } from "../lib/gateway/selector";
import { chainKeyForId, getSourceChain } from "../lib/gateway/chains";
import { redeemPeriodicTransfer, decodePeriodTransferTerms } from "../lib/chain/delegation";
import { getRelayerAddress } from "../lib/chain/signers";
import { mandateGrantsWhere, periodConsumed } from "../lib/rail";
import { advanceBridge } from "./bridge";
import { fireWebhook } from "../lib/webhooks/delivery";

function platformFeeBps(): bigint {
  return BigInt(process.env.PLATFORM_FEE_BPS ?? "0");
}

/// Why a charge could not be attempted. These map onto the documented API codes,
/// and each one is decided BEFORE any funds move.
export type ChargeRefusal =
  | "mandate_not_active"
  | "mandate_expired"
  | "amount_over_cap"
  | "mandate_period_consumed"
  | "insufficient_funds"
  | "no_payout_wallet"
  | "no_grants";

export class ChargeError extends Error {
  constructor(public reason: ChargeRefusal, message: string) {
    super(message);
  }
}

type ChargeContext = NonNullable<Awaited<ReturnType<typeof loadCharge>>>;

async function loadCharge(chargeDbId: string) {
  return prisma.charge.findUnique({
    where: { id: chargeDbId },
    select: {
      id: true, chargeId: true, amount: true, status: true, merchantId: true,
      externalRef: true, isTestMode: true, description: true,
      merchant: { select: { merchantId: true, walletAddress: true } },
      mandate: {
        select: {
          id: true, mandateId: true, status: true, expiresAt: true,
          maxAmount: true, periodDuration: true, walletAddress: true,
        },
      },
    },
  });
}

/// Everything that can refuse a charge, checked in order of cost: mandate state,
/// then the signed cap, then the period, then on-chain balances last because that
/// is the only check that costs RPC calls.
export async function planCharge(c: ChargeContext) {
  const m = c.mandate;
  if (m.status !== "active") {
    throw new ChargeError("mandate_not_active", `Mandate ${m.mandateId} is ${m.status}, not active`);
  }
  if (m.expiresAt.getTime() < Date.now()) {
    throw new ChargeError("mandate_expired", `Mandate ${m.mandateId} expired on ${m.expiresAt.toISOString()}`);
  }
  if (c.amount > m.maxAmount) {
    throw new ChargeError(
      "amount_over_cap",
      `Charge ${c.amount} exceeds the mandate's authorized ceiling ${m.maxAmount}`
    );
  }
  if (!c.merchant.walletAddress) {
    throw new ChargeError("no_payout_wallet", "This account has no payout wallet configured");
  }

  const grants = await prisma.renewalDelegation.findMany({
    where: { ...mandateGrantsWhere(m.mandateId), status: "active" },
    select: {
      id: true, grantId: true, chainId: true, token: true, context: true,
      delegateAddress: true, delegationManager: true, periodAmount: true,
      periodDuration: true, lastRedeemedAt: true,
    },
  });
  if (grants.length === 0) {
    throw new ChargeError("no_grants", `Mandate ${m.mandateId} has no active grant on any chain`);
  }

  // The signed context is authoritative for the cap, not the mandate row: the
  // subscriber may have granted less than the developer asked for. It also carries
  // the enforcer's period schedule, which is the only way to know whether this
  // period is already spent — so decode once and keep it.
  const decoded = grants.map((g) => ({
    grant: g,
    terms: decodePeriodTransferTerms(g.context as Hex, g.token as Address),
  }));
  const affordable = decoded.filter(({ terms }) => !terms || terms.periodAmount >= c.amount);
  if (affordable.length === 0) {
    throw new ChargeError(
      "amount_over_cap",
      `No grant on this mandate has a signed cap covering ${c.amount}`
    );
  }

  // One redeem per period, per chain. A chain consumed this period is not a
  // failure — another chain may be free.
  const usable = affordable
    .filter(({ grant, terms }) => !terms || !periodConsumed(grant, terms))
    .map(({ grant }) => grant);
  if (usable.length === 0) {
    throw new ChargeError(
      "mandate_period_consumed",
      "Every granted chain has already been charged this period — wait for the next one"
    );
  }

  const allowedChainKeys = usable
    .map((g) => chainKeyForId(g.chainId))
    .filter((k): k is string => !!k && k !== "arc");
  const selection = await selectPaymentChain(m.walletAddress as Hex, {
    amount: c.amount,
    allowedChainKeys,
    requireDeployedAccount: true,
  });
  if (!selection.sufficient) {
    throw new ChargeError(
      "insufficient_funds",
      `Wallet holds less than ${c.amount} on every granted chain (tried: ${allowedChainKeys.join(", ") || "none"})`
    );
  }
  const chosenKey = selection.chain.kind === "arc" ? "arc" : selection.chain.key;
  const grant = usable.find((g) => chainKeyForId(g.chainId) === chosenKey);
  if (!grant) {
    throw new ChargeError("insufficient_funds", `No usable grant for the selected chain ${chosenKey}`);
  }
  return { grant, chainKey: chosenKey, payout: c.merchant.walletAddress as Address };
}

/// Record settlement: the charge succeeded, and the bridge row that carried it is
/// minted — in one transaction, so a crash cannot leave a minted bridge with a
/// pending charge in front of it.
async function recordChargeSettled(c: ChargeContext, chainKey: string, mintTxHash: Hex, bridgeId: string) {
  await prisma.$transaction([
    prisma.charge.update({
      where: { id: c.id },
      data: { status: "succeeded", txHash: mintTxHash, chain: chainKey, settledAt: new Date() },
    }),
    prisma.bridgeTransfer.update({
      where: { id: bridgeId },
      data: { status: "minted", mintTxHash, mintedAt: new Date() },
    }),
  ]);

  await fireWebhook(c.merchantId, c.externalRef ?? "", c.merchant.merchantId, "charge.succeeded", {
    charge_id: c.chargeId,
    mandate_id: c.mandate.mandateId,
    external_ref: c.externalRef,
    amount: Number(c.amount),
    currency: "USDC",
    // Where the money came FROM. It always lands on Arc, which is why the tx hash
    // is an Arc mint and the source chain is reported separately.
    source_chain: chainKey,
    chain: "arc",
    tx_hash: mintTxHash,
    description: c.description,
  }).catch((e) => console.error(`[charge] ${c.chargeId} webhook failed:`, e));
}

async function failCharge(c: ChargeContext, reason: string, detail: string) {
  await prisma.charge.update({
    where: { id: c.id },
    data: { status: "failed", failureReason: `${reason}: ${detail}` },
  });
  await fireWebhook(c.merchantId, c.externalRef ?? "", c.merchant.merchantId, "charge.failed", {
    charge_id: c.chargeId,
    mandate_id: c.mandate.mandateId,
    external_ref: c.externalRef,
    amount: Number(c.amount),
    currency: "USDC",
    failure_code: reason,
    failure_reason: detail,
  }).catch((e) => console.error(`[charge] ${c.chargeId} webhook failed:`, e));
}

/// Collect one charge. Runs detached from the request — the API answered 202 the
/// moment the row existed, because a cross-chain collection takes seconds to
/// minutes and no HTTP client should be made to hold that open.
///
/// Never throws: a charge that cannot be collected is recorded as failed, because
/// an unhandled rejection in a detached task is a charge nobody hears about again.
export async function executeCharge(chargeDbId: string): Promise<void> {
  const c = await loadCharge(chargeDbId);
  if (!c) return void console.error(`[charge] ${chargeDbId} vanished before execution`);
  if (c.status !== "pending") return; // already settled or failed — nothing to do

  let plan;
  try {
    plan = await planCharge(c);
  } catch (e) {
    if (e instanceof ChargeError) {
      console.warn(`[charge] ${c.chargeId} refused: ${e.reason} — ${e.message}`);
      await failCharge(c, e.reason, e.message);
      return;
    }
    console.error(`[charge] ${c.chargeId} planning failed:`, e);
    await failCharge(c, "internal_error", e instanceof Error ? e.message : String(e));
    return;
  }

  const fee = (c.amount * platformFeeBps()) / 10_000n;
  const merchantShare = c.amount - fee;
  const source = getSourceChain(plan.chainKey);

  try {
    // Funds move here. Everything after this point resumes; nothing re-pulls.
    await redeemPeriodicTransfer({
      chainId: plan.grant.chainId,
      delegationManager: plan.grant.delegationManager as Address,
      context: plan.grant.context as Hex,
      delegate: plan.grant.delegateAddress as Address,
      token: source.usdc,
      recipient: getRelayerAddress("external"),
      amount: c.amount, // full amount; the fee stays behind on the source chain
    });
  } catch (e) {
    // Nothing moved, so this is safe to record as a plain failure and safe for the
    // developer to retry with a new Idempotency-Key.
    console.error(`[charge] ${c.chargeId} redeem failed on ${plan.chainKey}:`, e);
    await failCharge(c, "redeem_failed", e instanceof Error ? e.message : String(e));
    return;
  }

  // Stamp the grant so the next charge sees this period as consumed without an
  // RPC call, and so the reconciler's view of the mandate stays honest.
  await prisma.renewalDelegation.update({
    where: { id: plan.grant.id },
    data: { lastRedeemedAt: new Date() },
  });

  const bridge = await prisma.bridgeTransfer.create({
    data: {
      chargeId: c.id,
      mandateId: plan.grant.id,
      chainId: plan.grant.chainId,
      sourceDomain: source.domain,
      grossAmount: c.amount,
      bridgedAmount: merchantShare,
      mintRecipient: plan.payout,
      status: "pulled",
    },
  });

  try {
    const mintTx = await advanceBridge(bridge, (tx) =>
      recordChargeSettled(c, plan.chainKey, tx, bridge.id)
    );
    if (!mintTx) {
      console.log(`[charge] ${c.chargeId} burned, mint pending — resume pass will finish it`);
    }
  } catch (e) {
    // The money is with the relayer or already burned. The charge stays pending on
    // purpose: the resume pass owns it now, and marking it failed would tell the
    // developer nothing was collected when in fact it is in flight.
    console.error(`[charge] ${c.chargeId} bridge stalled (funds in flight, will resume):`, e);
  }
}

/// Finish charges whose bridge is mid-flight. Mirrors the renewal pass's
/// resume-before-pull step; without it a charge whose mint failed would sit
/// pending forever with the subscriber's money already pulled.
export async function resumeChargeBridges(): Promise<number> {
  const rows = await prisma.bridgeTransfer.findMany({
    where: { chargeId: { not: null }, status: { in: ["pulled", "burned"] } },
    orderBy: { createdAt: "asc" },
  });
  let settled = 0;
  for (const bridge of rows) {
    const c = await loadCharge(bridge.chargeId!);
    if (!c) {
      console.error(`[charge/resume] bridge ${bridge.id} has no charge`);
      continue;
    }
    const chainKey = chainKeyForId(bridge.chainId) ?? "source";
    try {
      const mintTx = await advanceBridge(bridge, (tx) => recordChargeSettled(c, chainKey, tx, bridge.id));
      if (mintTx) settled++;
    } catch (e) {
      console.error(`[charge/resume] ${c.chargeId} still stalled:`, e);
    }
  }
  if (rows.length > 0) console.log(`[charge/resume] ${settled}/${rows.length} in-flight charges settled`);
  return settled;
}
