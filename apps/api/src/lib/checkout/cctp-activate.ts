// Cross-chain checkout via CCTP V2 (delegation-funded).
//
// Arc is the primary chain — a subscriber with enough Arc USDC activates with the
// gasless permit path (no CCTP). When Arc is short, cross-chain is enabled ONCE:
//   1. a one-time setup fee (PLATFORM_SETUP_FEE_USDC) paid gaslessly via ERC-3009
//      to the platform treasury,
//   2. an ERC-7715 delegation per funded source chain (cap = plan amount),
//   3. an Arc EIP-2612 permit.
// The platform then funds the activation by redeeming the delegation on a source
// chain, CCTP-bridging the EXACT plan amount to Arc (platform covers gas + the
// bridge fee), and activating via subscribeWithPermit. Renewals reuse the same
// delegation (Arc-first, source otherwise — see billing/delegated-renewal.ts).

import { toHex, type Address, type Hex } from "viem";
import { randomBytes } from "crypto";
import { prisma, withRetry } from "../prisma";
import { ids } from "../ids";
import { completeCheckoutSession, INTERVAL_SECONDS } from "./complete";
import { resolveTier } from "./tiers";
import {
  getManagerAddress,
  getPublicClient,
  getUsdcAddress,
  subscribeWithPermitOnChain,
} from "../chain/contract";
import { settlementWindowSeconds } from "../chain/subscription";
import {
  getDelegateAddress,
  redeemPeriodicTransfer,
  relayerBridgeToArc,
  relayerPullViaAuthorization,
  splitSignature,
} from "../chain/delegation";
import { fetchAttestation, getTokenMessenger, receiveOnArc } from "../gateway/cctp";
import { ARC_DOMAIN, chainKeyForId, getSourceChain, getSourceClient } from "../gateway/chains";
import { selectPaymentChain } from "../gateway/selector";

// ─── Config ───────────────────────────────────────────────────────────────────

/// One-time fee (USDC micro-units) charged when a subscriber enables cross-chain.
export function setupFeeMicro(): bigint {
  return BigInt(process.env.PLATFORM_SETUP_FEE_USDC ?? "1000000"); // 1 USDC
}

function treasuryAddress(): Address {
  const t = process.env.PLATFORM_TREASURY_ADDRESS;
  if (!t) throw new Error("PLATFORM_TREASURY_ADDRESS not set");
  return t as Address;
}

// ─── EIP-712 payload builders (server-built, subscriber-signed) ───────────────

export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

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

const randomBytes32 = (): Hex => toHex(randomBytes(32));

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

/// Build the one-time setup-fee ERC-3009 TransferWithAuthorization on a source
/// chain (subscriber → platform treasury). Submitted by the relayer (gasless).
export async function buildSetupFeePayload(chainKey: string, subscriber: Hex): Promise<TypedDataPayload> {
  const source = getSourceChain(chainKey);
  const client = getSourceClient(source);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  return {
    domain: await usdcDomain(client as never, source.usdc, source.chain.id),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: subscriber,
      to: treasuryAddress(),
      value: setupFeeMicro().toString(),
      validAfter: "0",
      validBefore: (nowSec + 7_200n).toString(), // 2h window
      nonce: randomBytes32(),
    },
  };
}

/// Build the EIP-2612 Arc-USDC permit payload (the recurring allowance). Shared
/// with the same-chain gasless checkout path in routes/public.ts.
export async function buildPermitPayload(
  subscriber: Hex,
  permitValue: bigint,
  deadline: bigint
): Promise<TypedDataPayload> {
  const client = getPublicClient();
  const usdc = getUsdcAddress();
  const [domain, nonce] = await Promise.all([
    usdcDomain(client as never, usdc, client.chain!.id),
    client
      .readContract({ address: usdc, abi: ERC20_META_ABI, functionName: "nonces", args: [subscriber] })
      .catch(() => 0n),
  ]);
  return {
    domain,
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: {
      owner: subscriber,
      spender: getManagerAddress(),
      value: permitValue.toString(),
      nonce: (nonce as bigint).toString(),
      deadline: deadline.toString(),
    },
  };
}

// ─── Setup-fee collection ────────────────────────────────────────────────────

/// Submit the subscriber's signed one-time setup fee (ERC-3009 → treasury). The
/// on-chain transfer is the record; the ERC-3009 nonce makes a replay revert, and
/// the route's single-claim guard ensures this runs once per enable. Returns the
/// fee tx hash.
export async function collectSetupFee(
  sessionId: string,
  subscriber: Hex,
  feeChainKey: string,
  payload: TypedDataPayload,
  signature: Hex
): Promise<Hex> {
  const source = getSourceChain(feeChainKey);
  const msg = payload.message as { value: string; validAfter: string; validBefore: string; nonce: Hex };
  const { txHash } = await relayerPullViaAuthorization({
    chainId: source.chain.id,
    token: source.usdc,
    from: subscriber,
    to: treasuryAddress(),
    value: BigInt(msg.value),
    validAfter: BigInt(msg.validAfter),
    validBefore: BigInt(msg.validBefore),
    nonce: msg.nonce,
    signature,
  });
  console.log(`[checkout/cctp] setup fee collected for session ${sessionId} on ${feeChainKey} (tx ${txHash})`);
  return txHash;
}

// ─── Cross-chain activation (Arc-short checkout) ─────────────────────────────

export interface ActivationPermit {
  permitSignature: Hex;
  permitValue: bigint;
  permitDeadline: bigint;
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
/// subscriber) → subscribeWithPermit (escrow first period) → record + webhooks.
/// Status is persisted on the Sweep row for the checkout UI to poll.
export async function executeCrossChainActivation(
  sweepDbId: string,
  permit: ActivationPermit
): Promise<void> {
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

    const grantedKeys = mandates
      .map((m) => chainKeyForId(m.chainId))
      .filter((k): k is string => !!k && k !== "arc");

    const selection = await selectPaymentChain(subscriber, { amount, allowedChainKeys: grantedKeys });
    if (!selection.sufficient || selection.chain.kind !== "source") {
      throw new Error(`no granted source chain holds ${amount} for ${subscriber}`);
    }
    const chosenKey = selection.chain.key;
    const mandate = mandates.find((m) => chainKeyForId(m.chainId) === chosenKey);
    if (!mandate) throw new Error(`no mandate for ${chosenKey}`);
    const source = getSourceChain(chosenKey);

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

    // 2. CCTP Fast burn → mint EXACTLY `amount` to the subscriber on Arc (relayer
    //    burns amount + fee from its float, so the bridge fee never reduces it).
    await setSweepStatus(sweepDbId, "bridging");
    const { burnTxHash } = await relayerBridgeToArc({
      chainId: source.chain.id,
      token: source.usdc,
      tokenMessenger: getTokenMessenger(chosenKey),
      amount,
      destinationDomain: ARC_DOMAIN,
      mintRecipient: subscriber,
      speed: "fast",
    });
    const att = await fetchAttestation(source.domain, burnTxHash, { timeoutMs: 180_000, pollMs: 6_000 });
    await receiveOnArc(att);

    // 3. Activate on Arc via the permit path (escrow the first period).
    await setSweepStatus(sweepDbId, "minting");
    const { v, r, s } = splitSignature(permit.permitSignature);
    const { txHash, blockNumber } = await subscribeWithPermitOnChain({
      subId: ids.toBytes32(session.sessionId),
      subscriber,
      merchantPayout: session.merchant.walletAddress as Hex,
      planId: ids.toBytes32(plan.planId),
      amount,
      interval: BigInt(INTERVAL_SECONDS[tier.interval] ?? INTERVAL_SECONDS.monthly),
      trialDuration: BigInt(tier.trialDays * 86_400),
      settlementWindow: BigInt(settlementWindowSeconds(tier.settlementWindowHours)),
      permitValue: permit.permitValue,
      permitDeadline: permit.permitDeadline,
      permitV: v,
      permitR: r,
      permitS: s,
    });

    await completeCheckoutSession({
      session,
      walletAddress: subscriber,
      activationMethod: "cctp",
      email: sweep.subscriberEmail,
      txHash,
      blockNumber: Number(blockNumber),
    });

    await withRetry(() =>
      prisma.sweep.update({
        where: { id: sweepDbId },
        data: { status: "complete", activationTxHash: txHash, error: null },
      })
    );
    console.log(`[checkout/cctp] ${sweep.sweepId} activated cross-chain — tx ${txHash}`);
  } catch (e) {
    console.error(`[checkout/cctp] ${sweep.sweepId} activation failed:`, e);
    await setSweepStatus(sweepDbId, "failed", String(e instanceof Error ? e.message : e).slice(0, 500));
  }
}
