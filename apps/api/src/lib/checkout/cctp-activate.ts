// Cross-chain checkout via CCTP V2 (delegation-funded).
//
// Arc is the primary chain — a subscriber with enough Arc USDC activates with the
// gasless permit path (no CCTP). When Arc is short, cross-chain is enabled ONCE:
//   1. an ERC-7715 delegation per funded source chain (cap = plan amount),
//   2. an Arc EIP-2612 permit.
// The platform then funds the activation by redeeming the delegation on a source
// chain and CCTP-bridging the merchant's share straight into their Arc payout
// wallet. The relayer covers gas and the bridge fee out of the 2% platform fee, so
// the subscriber pays nothing extra.
//
// NO CONTRACT IS CALLED. This used to mint to the subscriber and then activate
// through SubscriptionManager.subscribeWithPermit, which escrowed the first period
// for the settlement window. It now settles exactly the way a cross-chain RENEWAL
// already does (billing/delegated-renewal.ts): fee split off-chain, merchant paid
// by the mint itself, nothing held.
//
// Two consequences, both deliberate:
//   • the merchant is paid in seconds rather than after a 24h window, and
//   • there is no escrow, so there is no refund path — the contract calls the
//     settlement window "the ONLY refund path", and this path no longer has one.

import { type Address, type Hex } from "viem";
import { prisma, withRetry } from "../prisma";
import { completeCheckoutSession } from "./complete";
import { findWalletConflict } from "./wallet-guard";

/// The platform's cut, in basis points. Split here rather than by a contract —
/// the same arithmetic billing/delegated-renewal.ts does for a renewal.
function platformFeeBps(): bigint {
  return BigInt(process.env.PLATFORM_FEE_BPS ?? "0");
}
import { resolveTier } from "./tiers";
import {
  getPublicClient,
  getUsdcAddress,
} from "../chain/contract";
import {
  getDelegateAddress,
  redeemPeriodicTransfer,
  relayerBridgeToArc,
} from "../chain/delegation";
import { fetchAttestation, getTokenMessenger, receiveOnArc } from "../gateway/cctp";
import { ARC_DOMAIN, chainKeyForId, getSourceChain } from "../gateway/chains";
import { selectPaymentChain } from "../gateway/selector";

// ─── EIP-712 payload builders (server-built, subscriber-signed) ───────────────

export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const ERC20_META_ABI = [
  { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "version", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "nonces", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

async function usdcDomain(
  client: { readContract: (a: never) => Promise<unknown> },
  usdc: Hex,
  chainId: number
): Promise<Record<string, unknown>> {
  const read = client.readContract as (a: unknown) => Promise<unknown>;
  const [name, version] = await Promise.all([
    read({ address: usdc, abi: ERC20_META_ABI, functionName: "name" }).catch(() => "USDC"),
    read({ address: usdc, abi: ERC20_META_ABI, functionName: "version" }).catch(() => "2"),
  ]);
  return { name: name as string, version: version as string, chainId, verifyingContract: usdc };
}

async function setSweepStatus(sweepDbId: string, status: string, error?: string) {
  await withRetry(() =>
    prisma.sweep.update({
      where: { id: sweepDbId },
      data: { status, ...(error !== undefined ? { error } : {}) },
    })
  );
}

/// Fund + activate a cross-chain subscription, detached from the HTTP request:
/// redeem the granted delegation on a source chain (pull EXACTLY the plan amount)
/// → CCTP-bridge to Arc (relayer covers gas + fee, so the full amount mints to the
/// merchant's payout wallet) → record + webhooks. The mint IS the settlement.
/// Status is persisted on the Sweep row for the checkout UI to poll.
export async function executeCrossChainActivation(sweepDbId: string): Promise<void> {
  const sweep = await withRetry(() =>
    prisma.sweep.findUniqueOrThrow({
      where: { id: sweepDbId },
      include: { session: { include: { plan: true, merchant: true } } },
    })
  );
  const session = sweep.session;
  const plan = session.plan;
  const subscriber = sweep.walletAddress as Hex;
  const tier = await resolveTier(plan, session.tierId);
  const amount = tier.amount;

  try {
    // Delegations granted during enable are bound to the session. Pick a granted
    // source chain that currently holds at least one period.
    const mandates = await prisma.renewalDelegation.findMany({
      where: { sessionId: session.sessionId, status: "active" },
    });
    if (mandates.length === 0) throw new Error("no granted delegation for this session");

    // A TRIAL TAKES NO MONEY. Nothing below this point may run for one: the
    // redeem, the burn and the mint are all a charge, and the subscriber was told
    // the first period is free.
    //
    // This used to be the contract's job. subscribeWithPermit received
    // trialDuration and escrowed nothing, and the mint went to the SUBSCRIBER'S
    // own Arc address — so the pull was a transfer between the subscriber's own
    // chains and cost them nothing. Re-pointing that mint at the merchant turned
    // the same pull into a payment, and the trial check went out with the
    // contract. One free trial was charged 5 USDC before this was caught.
    //
    // The grant is already signed and bound to the session, so the first real
    // collection happens when the trial ends: transitionTrials flips the status
    // and leaves the period due, and the renewal pass collects it.
    if (tier.trialDays > 0) {
      await setSweepStatus(sweepDbId, "complete");
      await completeCheckoutSession({
        session,
        walletAddress: subscriber,
        activationMethod: "cctp",
        email: sweep.subscriberEmail,
        customerDbId: sweep.customerId,
        // No transaction, because nothing moved. A tx hash here would point at
        // something that never happened.
        platformSettled: true,
      });
      await withRetry(() =>
        prisma.sweep.update({
          where: { id: sweepDbId },
          data: { status: "complete", error: null },
        })
      );
      console.log(`[checkout/cctp] ${sweep.sweepId} activated on a ${tier.trialDays}-day trial — no funds moved`);
      return;
    }

    const grantedKeys = mandates
      .map((m) => chainKeyForId(m.chainId))
      .filter((k): k is string => !!k && k !== "arc");

    const selection = await selectPaymentChain(subscriber, {
      amount,
      allowedChainKeys: grantedKeys,
      requireDeployedAccount: true,
    });
    if (!selection.sufficient || selection.chain.kind !== "source") {
      throw new Error(`no granted source chain holds ${amount} for ${subscriber}`);
    }
    const chosenKey = selection.chain.key;
    const mandate = mandates.find((m) => chainKeyForId(m.chainId) === chosenKey);
    if (!mandate) throw new Error(`no mandate for ${chosenKey}`);
    const source = getSourceChain(chosenKey);

    // The route checked this before accepting the activation, but funds have not
    // moved yet and this is the last moment a refusal is free. Without escrow
    // there is nothing to refund afterwards, so the window between the two checks
    // is the entire exposure — keep it to this.
    const clash = await findWalletConflict({
      merchantId: session.merchantId,
      walletAddress: subscriber,
      identity: { customerDbId: sweep.customerId, email: sweep.subscriberEmail },
    });
    if (clash) {
      throw new Error(
        `wallet ${subscriber.toLowerCase()} is already paying for ${clash.subscriptionId} at this merchant`
      );
    }

    // The merchant's share and the platform's, split here rather than on-chain.
    // The full amount is pulled from the subscriber; only the share is bridged, so
    // the fee stays behind as source-chain USDC in the relayer's balance.
    const fee = (amount * platformFeeBps()) / 10_000n;
    const merchantShare = amount - fee;
    const payout = session.merchant.walletAddress as Hex;
    if (!payout) throw new Error("merchant has no payout wallet");

    // 1. Redeem the delegation — pull EXACTLY `amount` to the relayer.
    await setSweepStatus(sweepDbId, "depositing");
    await redeemPeriodicTransfer({
      chainId: mandate.chainId,
      delegationManager: mandate.delegationManager as Address,
      context: mandate.context as Hex,
      token: source.usdc,
      recipient: getDelegateAddress(),
      amount,
    });

    // Record that this grant's period is now spent. The enforcer knows, but the
    // database did not, and the renewal pass reads this to decide whether an
    // attempt is worth making — without it, the first renewal after a checkout
    // pays gas for a transaction the enforcer is certain to reject.
    await withRetry(() =>
      prisma.renewalDelegation.update({
        where: { id: mandate.id },
        data: { lastRedeemedAt: new Date() },
      })
    );

    // 2. CCTP Fast burn → mint the merchant's share DIRECTLY to their Arc payout
    //    wallet. The relayer absorbs the bridge fee from its float, so the
    //    merchant receives the full share.
    await setSweepStatus(sweepDbId, "bridging");
    const { burnTxHash } = await relayerBridgeToArc({
      chainId: source.chain.id,
      token: source.usdc,
      tokenMessenger: getTokenMessenger(chosenKey),
      amount: merchantShare,
      destinationDomain: ARC_DOMAIN,
      mintRecipient: payout,
      speed: "fast",
    });
    const att = await fetchAttestation(source.domain, burnTxHash, { timeoutMs: 180_000, pollMs: 6_000 });

    // 3. The mint IS the settlement. There is no third step any more.
    await setSweepStatus(sweepDbId, "minting");
    const txHash = await receiveOnArc(att);

    await completeCheckoutSession({
      session,
      walletAddress: subscriber,
      activationMethod: "cctp",
      email: sweep.subscriberEmail,
      // Proven at activate time; without it this call falls back to the wallet
      // link and attributes the subscription to the wrong customer.
      customerDbId: sweep.customerId,
      txHash,
      // Settled by the platform: no SubscriptionManager call, so there is nothing
      // on-chain to verify and no escrow to mirror.
      platformSettled: true,
      // The chain the money was actually pulled from, so the receipt and the
      // merchant's webhook name it rather than defaulting to Arc.
      sourceChain: chosenKey,
    });

    await withRetry(() =>
      prisma.sweep.update({
        where: { id: sweepDbId },
        data: { status: "complete", activationTxHash: txHash, sourceChain: chosenKey, error: null },
      })
    );
    console.log(`[checkout/cctp] ${sweep.sweepId} activated cross-chain — tx ${txHash}`);
  } catch (e) {
    console.error(`[checkout/cctp] ${sweep.sweepId} activation failed:`, e);
    await setSweepStatus(sweepDbId, "failed", String(e instanceof Error ? e.message : e).slice(0, 500));
  }
}
