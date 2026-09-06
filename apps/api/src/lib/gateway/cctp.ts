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
  slice,
  type Address,
  type Hex,
} from "viem";
import { arcChainId } from "./chains";
import { getRelayerAccount } from "../chain/signers";
import { withNonce } from "../chain/nonce";

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
  // Non-zero once a message has been minted, by anyone. This is how we tell
  // "already delivered" apart from "failed" — see receiveOnArc.
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "nonce", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "MessageReceived",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "sourceDomain", type: "uint32", indexed: false },
      { name: "nonce", type: "bytes32", indexed: true },
      { name: "sender", type: "bytes32", indexed: false },
      { name: "finalityThresholdExecuted", type: "uint32", indexed: true },
      { name: "messageBody", type: "bytes", indexed: false },
    ],
  },
] as const;

const MESSAGE_RECEIVED_EVENT = MESSAGE_TRANSMITTER_ABI[2];

// getLogs is capped per request by most providers (10k blocks on the Arc RPC we
// use), so a lookup walks back in windows rather than asking for all of history.
// Six windows of 9k blocks is roughly 15 hours at Arc's ~1s blocks — comfortably
// longer than the seconds it takes an auto-relayer to win a race, and long enough
// for a bridge resumed on the next billing pass.
const LOG_WINDOW = 9_000n;
const LOG_WINDOWS_BACK = 6;

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
  const account = getRelayerAccount("hosted");
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

type ArcClient = ReturnType<typeof arcRelayer>["publicClient"];

/// The message's CCTP nonce. V2 header: version(4) sourceDomain(4)
/// destinationDomain(4) nonce(32) — so bytes 12..44.
///
/// Note this is Circle's per-message nonce, nothing to do with the account nonce
/// the relayer signs with. Both revert with the word "nonce" and they are entirely
/// different failures.
function messageNonce(message: Hex): Hex {
  return slice(message, 12, 44);
}

async function isAlreadyMinted(publicClient: ArcClient, nonce: Hex): Promise<boolean> {
  const used = await publicClient.readContract({
    address: getArcMessageTransmitter(),
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: "usedNonces",
    args: [nonce],
  });
  return used !== 0n;
}

/// The transaction that actually delivered this message, whoever sent it.
/// MessageReceived indexes the nonce, so this is an exact lookup once the right
/// window is in range.
async function findMintTx(publicClient: ArcClient, nonce: Hex): Promise<Hex | null> {
  const head = await publicClient.getBlockNumber();
  for (let i = 0; i < LOG_WINDOWS_BACK; i++) {
    const toBlock = head - BigInt(i) * LOG_WINDOW;
    if (toBlock <= 0n) break;
    const fromBlock = toBlock > LOG_WINDOW ? toBlock - LOG_WINDOW : 0n;
    const logs = await publicClient.getLogs({
      address: getArcMessageTransmitter(),
      event: MESSAGE_RECEIVED_EVENT,
      args: { nonce },
      fromBlock,
      toBlock,
    });
    if (logs[0]?.transactionHash) return logs[0].transactionHash;
    if (fromBlock === 0n) break;
  }
  return null;
}

/// Resolve an already-delivered message to the transaction that delivered it.
async function settledElsewhere(publicClient: ArcClient, nonce: Hex): Promise<Hex> {
  const hash = await findMintTx(publicClient, nonce);
  if (hash) {
    console.log(`[cctp] message ${nonce} was already minted on Arc by ${hash} — treating as delivered`);
    return hash;
  }
  // The funds ARE on Arc — usedNonces said so — we just cannot name the
  // transaction, so there is nothing truthful to record against the payment.
  // Loud and specific, because this is a bookkeeping problem and not a lost
  // payment, and the two want very different responses from whoever reads it.
  throw new Error(
    `CCTP message ${nonce} is already minted on Arc, but its MessageReceived log is ` +
      `outside the ${LOG_WINDOWS_BACK * Number(LOG_WINDOW)}-block lookback. The funds ` +
      `arrived; only the settlement reference is missing. Locate the mint and settle by hand.`
  );
}

/// Mint the bridged USDC on Arc by submitting the attestation to the Arc
/// MessageTransmitter. Funds mint to the burn's mintRecipient (the subscriber).
///
/// A message can only ever be minted ONCE, and we are not the only party who can
/// mint it — Circle runs auto-relayers that deliver attested messages on sight,
/// and on testnet they frequently beat us by a second or two. Losing that race is
/// the SUCCESS case: the subscriber has their USDC. Treating it as an error is
/// what stranded a checkout whose money had already landed, so every point at
/// which we could lose the race re-checks before failing.
export async function receiveOnArc(att: CctpAttestation): Promise<Hex> {
  const { account, publicClient, walletClient } = arcRelayer();
  const nonce = messageNonce(att.message);

  // Cheapest case: someone delivered it before we even tried. No gas, no race.
  if (await isAlreadyMinted(publicClient, nonce)) return settledElsewhere(publicClient, nonce);

  const { request } = await publicClient.simulateContract({
    address: getArcMessageTransmitter(),
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: "receiveMessage",
    args: [att.message, att.attestation],
    account,
  });

  let txHash: Hex;
  try {
    txHash = await withNonce(account.address, arcChainId(), publicClient, (nonce_) =>
      walletClient.writeContract({ ...request, nonce: nonce_ })
    );
  } catch (e) {
    // Lost between simulate and broadcast: the node rejected the call outright.
    if (await isAlreadyMinted(publicClient, nonce)) return settledElsewhere(publicClient, nonce);
    throw e;
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    // Lost between broadcast and inclusion — our transaction mined one block
    // behind the winner and reverted with "Nonce already used". Same outcome.
    if (await isAlreadyMinted(publicClient, nonce)) return settledElsewhere(publicClient, nonce);
    throw new Error(`receiveMessage reverted on Arc: ${txHash}`);
  }
  return txHash;
}
