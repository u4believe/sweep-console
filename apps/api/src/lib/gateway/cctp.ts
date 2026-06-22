// CCTP bridge for autonomous renewals.
//
// Chosen over Gateway burn intents because `depositForBurn` is an ON-CHAIN call
// the ERC-7710 delegation can drive — no off-chain subscriber signature. Source
// CCTP domains reuse the existing SourceChain.domain / ARC_DOMAIN (CCTP and
// Gateway share domain IDs).
//
// VALIDATE on Circle testnet (developers.circle.com/cctp) before trusting:
//   • TokenMessengerV2 (source) + MessageTransmitterV2 (Arc) addresses — env
//   • Arc's CCTP domain (we reuse ARC_DOMAIN = 26)
//   • the Iris attestation endpoint shape
//
// CCTP v2 `depositForBurn` carries speed: Fast = low finality threshold + a
// `maxFee` (paid, soft finality, used for the interactive "Pay from other chains"
// moments); Standard = hard finality + zero fee (free, used for renewals).

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcChainId } from "./chains";

// CCTP v2 TokenMessengerV2.depositForBurn (7-arg).
export const TOKEN_MESSENGER_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

export type BurnSpeed = "fast" | "standard";

// CCTP v2 finality thresholds: Fast = soft finality (paid), Standard = hard.
const FINALITY_FAST = 1000;
const FINALITY_STANDARD = 2000;

/// depositForBurn fee/finality for a speed tier. Fast caps Circle's Fast-Transfer
/// fee via maxFee — it MUST cover the quoted fee (else the transfer silently
/// degrades to Standard) AND be strictly LESS than `amount` (CCTP reverts
/// otherwise). We cap it at a small share of the amount (default 1% — well above
/// Circle's few-bps quote), clamped below `amount`. Standard pays nothing and
/// waits for hard finality. Override the share via CCTP_FAST_MAX_FEE_BPS.
export function burnParams(
  speed: BurnSpeed,
  amount: bigint
): { maxFee: bigint; minFinalityThreshold: number } {
  if (speed === "fast") {
    const bps = BigInt(process.env.CCTP_FAST_MAX_FEE_BPS ?? "100"); // 1%
    let maxFee = (amount * bps) / 10_000n;
    if (maxFee < 1n) maxFee = 1n;
    if (maxFee >= amount) maxFee = amount > 1n ? amount - 1n : 0n; // CCTP requires maxFee < amount
    return { maxFee, minFinalityThreshold: FINALITY_FAST };
  }
  return { maxFee: 0n, minFinalityThreshold: FINALITY_STANDARD };
}

const MESSAGE_TRANSMITTER_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

// CCTP V2 deploys its contracts at the SAME address on every supported EVM
// testnet. These are the published V2 testnet addresses — override per chain via
// env if Circle's deployment differs (CONFIRM Arc + the source chains at
// developers.circle.com/cctp before a real run).
const CCTP_V2_TESTNET_TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address;
const CCTP_V2_TESTNET_MESSAGE_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address;

/// CCTP TokenMessengerV2 on a source chain (override: CCTP_TOKEN_MESSENGER_<KEY>).
export function getTokenMessenger(chainKey: string): Address {
  return (process.env[`CCTP_TOKEN_MESSENGER_${chainKey.toUpperCase()}`] ??
    CCTP_V2_TESTNET_TOKEN_MESSENGER) as Address;
}

/// CCTP MessageTransmitterV2 on Arc (override: CCTP_MESSAGE_TRANSMITTER_ARC).
function getArcMessageTransmitter(): Address {
  return (process.env.CCTP_MESSAGE_TRANSMITTER_ARC ?? CCTP_V2_TESTNET_MESSAGE_TRANSMITTER) as Address;
}

function irisUrl(): string {
  return process.env.CCTP_IRIS_URL ?? "https://iris-api-sandbox.circle.com";
}

export interface CctpAttestation {
  message: Hex;
  attestation: Hex;
}

/// Poll Circle's Iris API for a burn's attestation, by source domain + burn tx
/// hash. Returns once the attestation is complete.
export async function fetchAttestation(
  sourceDomain: number,
  burnTxHash: Hex,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<CctpAttestation> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60_000);
  const pollMs = opts.pollMs ?? 10_000;
  for (;;) {
    const res = await fetch(
      `${irisUrl()}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`
    ).catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as {
        messages?: { message: string; attestation: string; status: string }[];
      };
      const m = data.messages?.[0];
      if (m && m.status === "complete" && m.attestation && m.attestation !== "PENDING") {
        return { message: m.message as Hex, attestation: m.attestation as Hex };
      }
    }
    if (Date.now() > deadline) throw new Error("Timed out waiting for CCTP attestation");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function arcRelayer() {
  const pk = process.env.RENEWAL_DELEGATE_PRIVATE_KEY ?? process.env.PLATFORM_PRIVATE_KEY;
  if (!pk) throw new Error("RENEWAL_DELEGATE_PRIVATE_KEY / PLATFORM_PRIVATE_KEY not set");
  const account = privateKeyToAccount(pk as Hex);
  const chain = defineChain({
    id: arcChainId(),
    name: "Arc",
    nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
    rpcUrls: {
      default: { http: [process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network/"] },
    },
  });
  return {
    account,
    publicClient: createPublicClient({ chain, transport: http() }),
    walletClient: createWalletClient({ account, chain, transport: http() }),
  };
}

/// Mint the bridged USDC on Arc by submitting the attestation to the Arc
/// MessageTransmitter. Funds mint to the burn's mintRecipient (the subscriber).
export async function receiveOnArc(att: CctpAttestation): Promise<Hex> {
  const { account, publicClient, walletClient } = arcRelayer();
  const { request } = await publicClient.simulateContract({
    address: getArcMessageTransmitter(),
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: "receiveMessage",
    args: [att.message, att.attestation],
    account,
  });
  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`receiveMessage reverted on Arc: ${txHash}`);
  return txHash;
}
