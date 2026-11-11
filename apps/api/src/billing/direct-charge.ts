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
//
// Settling notifies BOTH sides: charge.succeeded to the developer, and a receipt
// to the payer. A rail charge is a standing debit the payer never sees coming, so
// silence towards them is not a missing nicety — it is the difference between a
// receipt and an unexplained withdrawal.

import type { Address, Hex } from "viem";
import { platformFeeBps } from "../lib/platform-fee";
import { WALLET_SELECT, walletFor } from "../lib/merchant-wallet";
import { prisma } from "../lib/prisma";
import { selectPaymentChain } from "../lib/gateway/selector";
import { chainKeyForId, getSourceChain } from "../lib/gateway/chains";
import {
  assertAccountDeployed,
  redeemPeriodicTransfer,
  redeemSplitTransfer,
  decodePeriodTransferTerms,
  isDelegationDisabled,
} from "../lib/chain/delegation";
import { getRelayerAddress } from "../lib/chain/signers";
import { settlementTargetFor } from "../lib/chain/settlement-target";
import { mandateGrantsWhere, periodConsumed, mandatePeriodStart, periodCommitted } from "../lib/rail";
import { payFeeToTreasury } from "../lib/chain/fee-payout";
import { fireWebhook } from "../lib/webhooks/delivery";
import { sendRailChargeReceipt } from "../lib/email/rail-receipt";
import { chargeFailureReason } from "./charge-failure";
import { directSettlementEnabled, redeemableFee, settlementPayees, treasuryPayee } from "../lib/chain/direct-settlement";


/// Why a charge could not be attempted. These map onto the documented API codes,
/// and each one is decided BEFORE any funds move.
export type ChargeRefusal =
  | "mandate_not_active"
  | "mandate_expired"
  | "amount_over_cap"
  | "period_cap_exceeded"
  | "mandate_period_consumed"
  | "insufficient_funds"
  | "no_payout_wallet"
  | "no_grants"
  | "grant_disabled";

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
      merchant: { select: { merchantId: true, ...WALLET_SELECT } },
      mandate: {
        select: {
          id: true, mandateId: true, status: true, expiresAt: true,
          maxAmount: true, periodDuration: true, walletAddress: true,
          authorizedAt: true, createdAt: true,
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

  // Re-checked here, not only at the route. The route reserves against the period
  // inside a serializable transaction, but this runs later — seconds to minutes,
  // and after a resume it can be much later — by which time the period may have
  // rolled or other charges may have settled. Excluding this charge's own row
  // matters: it was counted at reservation time and would otherwise refuse itself.
  const since = mandatePeriodStart(m);
  const committed = await periodCommitted(prisma, m.id, since, c.id);
  if (committed + c.amount > m.maxAmount) {
    throw new ChargeError(
      "period_cap_exceeded",
      `Charge ${c.amount} would take this mandate to ${committed + c.amount} against a ` +
        `${m.maxAmount} ceiling for the period beginning ${since.toISOString()}`
    );
  }
  /**
   * The payout wallet for THIS CHARGE'S mode.
   *
   * A merchant has one per environment, and the charge says which it is. Read
   * unscoped — as `c.merchant.walletAddress` — a live charge against a
   * merchant who onboarded in test pays into the test wallet, succeeds, and
   * puts the money somewhere nobody controls.
   */
  const payoutWallet = walletFor(c.merchant, c.isTestMode);
  if (!payoutWallet.address) {
    throw new ChargeError(
      "no_payout_wallet",
      `This account has no payout wallet configured for ${c.isTestMode ? "test" : "live"} mode`
    );
  }

  const grants = await prisma.renewalDelegation.findMany({
    where: { ...mandateGrantsWhere(m.mandateId), status: "active" },
    select: {
      id: true, grantId: true, chainId: true, token: true, context: true,
      delegateAddress: true, delegationManager: true, delegationHash: true,
      periodAmount: true, periodDuration: true, lastRedeemedAt: true,
      // Selected so assertAccountDeployed can see it. Without it the guard
      // cannot tell "no dependencies" from "not loaded".
      dependencies: true,
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

  // Ask each chain whether its delegation is still enabled, before anything
  // moves money.
  //
  // reconcileMandates does this nightly and renewals run straight after it, so
  // the hosted path never sees a stale row. A rail charge has no such shelter:
  // it is a developer's API call at an arbitrary hour, and a delegation the
  // subscriber disabled in their wallet an hour ago still reads active here
  // until that pass runs. Without this the charge reaches redeemDelegations and
  // reverts — a spent relayer transaction, and a chain error naming none of the
  // cause.
  //
  // Checked per grant rather than only on the chain about to be picked, so a
  // disabled Base does not sink a charge Arbitrum could have carried.
  //
  // Fails OPEN. An unreadable chain leaves the grant in play: the redeem would
  // have been attempted anyway, so an RPC blip costs what it costs today rather
  // than refusing a charge the subscriber did authorize.
  const enabled = await Promise.all(
    usable.map(async (g) => {
      // Null hash predates identity recording; the reconciler skips these too.
      if (!g.delegationHash) return true;
      try {
        return !(await isDelegationDisabled(
          g.chainId,
          g.delegationManager as Address,
          g.delegationHash as Hex
        ));
      } catch (e) {
        console.warn(
          `[charge] ${m.mandateId}: could not read delegation state on chain ${g.chainId} — ` +
            `proceeding as enabled:`,
          e
        );
        return true;
      }
    })
  );
  const live = usable.filter((_, i) => enabled[i]);
  const disabled = usable.filter((_, i) => !enabled[i]);

  if (disabled.length > 0) {
    // One direction only, exactly as the reconciler: active → revoked, never
    // back. The subscriber's wallet is the authority on this.
    await prisma.renewalDelegation.updateMany({
      where: { id: { in: disabled.map((g) => g.id) } },
      data: { status: "revoked" },
    });
    console.log(
      `[charge] ${m.mandateId}: ${disabled.length} grant(s) disabled in the subscriber's wallet ` +
        `(chains ${disabled.map((g) => g.chainId).join(", ")}) — revoked locally`
    );
  }
  if (live.length === 0) {
    throw new ChargeError(
      "grant_disabled",
      "The subscriber has disabled this authorization in their wallet"
    );
  }

  const allowedChainKeys = live
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
  const grant = live.find((g) => chainKeyForId(g.chainId) === chosenKey);
  if (!grant) {
    throw new ChargeError("insufficient_funds", `No usable grant for the selected chain ${chosenKey}`);
  }
  return { grant, chainKey: chosenKey, payout: walletFor(c.merchant, c.isTestMode).address as Address };
}

/// Record settlement: the charge succeeded, and the bridge row that carried it is
/// minted — in one transaction, so a crash cannot leave a minted bridge with a
/// pending charge in front of it.
async function recordChargeSettled(
  c: ChargeContext,
  chainKey: string,
  // Nullable: Circle's auto-relayer may have delivered the mint before us, and an
  // RPC that will not serve logs leaves the arrival certain but unnamed. A charge
  // whose funds reached the merchant is succeeded either way — the alternative is
  // reporting an arrived payment as pending forever.
  mintTxHash: Hex | null,
  /**
   * Null under direct settlement: there is no bridge, because the funds never
   * left the chain the payer paid on. The settlement tx is the charge's tx.
   */
  bridgeId: string | null
) {
  await prisma.$transaction([
    prisma.charge.update({
      where: { id: c.id },
      data: { status: "succeeded", txHash: mintTxHash, chain: chainKey, settledAt: new Date() },
    }),
    // No bridge row to close under direct settlement: nothing was bridged.
    ...(bridgeId
      ? [
          prisma.bridgeTransfer.update({
            where: { id: bridgeId },
            data: { status: "minted", mintTxHash, mintedAt: new Date() },
          }),
        ]
      : []),
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
  },
      // The charge's mode, copied from the key that created it.
      c.isTestMode).catch((e) => console.error(`[charge] ${c.chargeId} webhook failed:`, e));

  // The payer gets told too. The webhook goes to the DEVELOPER; without this the
  // person whose wallet was debited on a standing authorization hears from
  // nobody, which is indistinguishable from an unexplained withdrawal. Awaited
  // rather than floated: executeCharge is the end of this charge's life, so a
  // floating promise here would live only as long as the process and be dropped
  // by a reload or a deploy. It never throws.
  await sendRailChargeReceipt(c.id);
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
  },
      // The charge's mode, copied from the key that created it.
      c.isTestMode).catch((e) => console.error(`[charge] ${c.chargeId} webhook failed:`, e));
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
    await failCharge(c, "internal_error", chargeFailureReason(e instanceof Error ? e.message : String(e)));
    return;
  }

  const fee = (c.amount * platformFeeBps()) / 10_000n;
  const merchantShare = c.amount - fee;
  const source = getSourceChain(plan.chainKey);

  try {
    // Before anything moves: this path cannot deploy a counterfactual account.
    assertAccountDeployed(plan.grant);

    /**
     * DIRECT SETTLEMENT: one call, two transfers, nothing in between.
     *
     * The grant pins the creator's wallet and the treasury as its only
     * payees, so this pays both out of the subscriber's wallet on the chain
     * they chose and the charge is finished. No relayer balance, no CCTP
     * burn, no BridgeTransfer row, no resume pass, and nothing that can be
     * left stranded if a mint fails — because there is no mint.
     */
    if (directSettlementEnabled()) {
      const wallet = walletFor(c.merchant, c.isTestMode);
      const payees = settlementPayees(wallet);
      if (!payees.ok) throw new Error(payees.reason);
      const settled = await redeemSplitTransfer({
        chainId: plan.grant.chainId,
        delegationManager: plan.grant.delegationManager as Address,
        context: plan.grant.context as Hex,
        delegate: plan.grant.delegateAddress as Address,
        token: source.usdc,
        creator: wallet.address as Address,
        treasury: treasuryPayee(),
        periodAmount: c.amount,
        fee: redeemableFee(wallet.address ?? "", fee),
      });
      await prisma.renewalDelegation.update({
        where: { id: plan.grant.id },
        data: { lastRedeemedAt: new Date() },
      });
      // Settled on the source chain, so that is the chain the charge cites —
      // not Arc, which is no longer in the path.
      await recordChargeSettled(c, plan.chainKey, settled.txHash as Hex, null);
      console.log(
        `[charge] ${c.chargeId} settled direct on ${plan.chainKey} (tx ${settled.txHash})`
      );
      return;
    }

    /**
     * Direct settlement is the only path, so there is no middle state.
     *
     * The catch here used to leave the charge PENDING on a failure and say
     * "the resume pass owns it now" — correct while a bridge could be
     * half-finished, with the subscriber's money pulled and the mint still
     * owed. redeemSplitTransfer has no such state: one redeemDelegations
     * either moves both transfers or reverts and moves neither.
     *
     * So a failure is a failure, and the charge says so rather than sitting
     * pending for a pass that no longer exists to pick it up.
     */
  } catch (e) {
    console.error(`[charge] ${c.chargeId} settlement failed:`, e);
    await failCharge(c, "internal_error", chargeFailureReason(e instanceof Error ? e.message : String(e)));
  }
}
