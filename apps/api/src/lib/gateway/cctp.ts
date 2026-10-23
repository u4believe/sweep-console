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
import { arcChainId, isMainnet } from "./chains";
import { arcChain } from "../chain/contract";
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
/// otherwise). Standard pays nothing and waits for hard finality.
///
/// maxFee is a CEILING, and the burn is `amount + maxFee` — so whatever Circle
/// does not charge is still minted, to the RECIPIENT, not returned to the relayer.
/// Every basis point of headroom is therefore money given away, scaling with the
/// amount and invisible in the books: at a fixed 10 bps against the 0.325 bps
/// Circle actually quotes mainnet→Arc, ~9.7 bps of each merchant share leaked,
/// about 4.8% of a 200 bps platform fee.
///
/// So size it from the live quote instead of guessing. CCTP_FAST_MAX_FEE_BPS is
/// now a CEILING rather than the value, and a route that cannot be quoted falls
/// back to it — the pre-quote behaviour, so a Circle outage costs margin but
/// never a payment. CCTP_FAST_FEE_MARGIN (default 3x) absorbs a fee that moves
/// between the quote and the burn; too low and the transfer silently degrades to
/// Standard, which is slow rather than broken.
export async function burnParams(
  speed: BurnSpeed,
  amount: bigint,
  route?: { sourceDomain: number; destinationDomain: number }
): Promise<{ maxFee: bigint; minFinalityThreshold: number }> {
  if (speed !== "fast") return { maxFee: 0n, minFinalityThreshold: FINALITY_STANDARD };

  const ceilingBps = Number(process.env.CCTP_FAST_MAX_FEE_BPS ?? "10");
  const margin = Number(process.env.CCTP_FAST_FEE_MARGIN ?? "3");
  const quoted = route
    ? await quoteFastFeeBps(route.sourceDomain, route.destinationDomain)
    : null;
  const bps = quoted === null ? ceilingBps : Math.min(quoted * margin, ceilingBps);

  // The quote is fractional (0.325), so scale to micro-bps before dividing.
  let maxFee = (amount * BigInt(Math.ceil(bps * 1e6))) / 10_000_000_000n;
  if (maxFee < 1n) maxFee = 1n;
  if (maxFee >= amount) maxFee = amount > 1n ? amount - 1n : 0n; // CCTP requires maxFee < amount
  return { maxFee, minFinalityThreshold: FINALITY_FAST };
}

/// Circle's published Fast-transfer fee for one route, in basis points, or null
/// when it cannot be read.
///
/// Basis points is confirmed, not assumed: the sandbox quotes 1.3 for Base→Arc,
/// which is the ~1.25 the old fixed default was sized against. Cached, because a
/// burn sits on the payment's critical path and a published fee moves on the
/// order of days.
const feeQuotes = new Map<string, { bps: number; at: number }>();
const FEE_QUOTE_TTL_MS = 5 * 60_000;

export async function quoteFastFeeBps(
  sourceDomain: number,
  destinationDomain: number
): Promise<number | null> {
  const key = `${sourceDomain}->${destinationDomain}`;
  const hit = feeQuotes.get(key);
  if (hit && Date.now() - hit.at < FEE_QUOTE_TTL_MS) return hit.bps;
  try {
    const res = await fetch(`${irisUrl()}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`);
    if (!res.ok) return null;
    const rows = (await res.json()) as { finalityThreshold?: number; minimumFee?: number }[];
    const fast = rows?.find((r) => r.finalityThreshold === FINALITY_FAST);
    if (typeof fast?.minimumFee !== "number" || !Number.isFinite(fast.minimumFee)) return null;
    feeQuotes.set(key, { bps: fast.minimumFee, at: Date.now() });
    return fast.minimumFee;
  } catch {
    return null;
  }
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
// Override when the RPC's cap is lower — some providers advertise 10k and refuse
// far less, and at least one refuses eth_getLogs entirely while reporting it as a
// range error. Both are survivable: see findMintTx.
const LOG_WINDOW = BigInt(process.env.CCTP_LOG_WINDOW_BLOCKS ?? "9000");
const LOG_WINDOWS_BACK = Number(process.env.CCTP_LOG_WINDOWS_BACK ?? "6");

// CCTP V2 deploys its contracts at the SAME address on every supported EVM
// chain within a network — one set for testnet, a different set for mainnet.
const CCTP_V2_TESTNET_TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address;
const CCTP_V2_TESTNET_MESSAGE_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address;

/**
 * CCTP V2 on mainnet. Verified on Base: 2,175 bytes at this address.
 *
 * This constant exists because its absence cost a real payment. The testnet
 * address was the unconditional fallback, so a mainnet deployment that had not
 * set CCTP_TOKEN_MESSENGER_BASE burned nothing at all — and did it quietly.
 */
const CCTP_V2_MAINNET_TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Address;
/// Verified on Arc AND Base mainnet: 2,175 bytes at this address on both.
const CCTP_V2_MAINNET_MESSAGE_TRANSMITTER = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as Address;

/**
 * CCTP TokenMessengerV2 on a source chain (override: CCTP_TOKEN_MESSENGER_<KEY>).
 *
 * THE DEFAULT FOLLOWS THE NETWORK. It used to be the testnet address on both,
 * which on mainnet is an address with NO CODE — and a call to an address with
 * no code succeeds and does nothing. So depositForBurn "worked": the
 * UserOperation reported success, the settlement log said "burned", no CCTP
 * message was ever emitted, and the attestation that was then waited for could
 * never arrive. The money stayed on the source chain while the subscriber's
 * payment timed out.
 *
 * A wrong address that reverts is a bug you find in a minute. A wrong address
 * that silently succeeds is the one that reaches production, so the default is
 * now network-aware rather than a single value that happens to be right on one
 * side.
 */
export function getTokenMessenger(chainKey: string): Address {
  const override = process.env[`CCTP_TOKEN_MESSENGER_${chainKey.toUpperCase()}`];
  if (override) return override as Address;
  return isMainnet() ? CCTP_V2_MAINNET_TOKEN_MESSENGER : CCTP_V2_TESTNET_TOKEN_MESSENGER;
}

/// CCTP MessageTransmitterV2 on Arc (override: CCTP_MESSAGE_TRANSMITTER_ARC).
function getArcMessageTransmitter(): Address {
  const override = process.env.CCTP_MESSAGE_TRANSMITTER_ARC;
  if (override) return override as Address;
  // Network-aware for the same reason as getTokenMessenger: the testnet
  // address has no code on Arc mainnet, and receiveMessage against it would
  // succeed while minting nothing.
  return isMainnet() ? CCTP_V2_MAINNET_MESSAGE_TRANSMITTER : CCTP_V2_TESTNET_MESSAGE_TRANSMITTER;
}

// Circle's attestation + fee service. The default follows the network: pointing
// mainnet at the sandbox would fetch attestations that never complete, and quote
// the sandbox's fee (1.3 bps) for a mainnet route that costs 0.325.
function irisUrl(): string {
  if (process.env.CCTP_IRIS_URL) return process.env.CCTP_IRIS_URL;
  return isMainnet() ? "https://iris-api.circle.com" : "https://iris-api-sandbox.circle.com";
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
  // The shared definition, not a local one: this built its own chain with a
  // network-aware id and a hardcoded TESTNET rpc, so on mainnet it addressed
  // chain 5042 at rpc.testnet.arc.io.
  const chain = arcChain();
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
  let head: bigint;
  try {
    head = await publicClient.getBlockNumber();
  } catch {
    return null;
  }
  for (let i = 0; i < LOG_WINDOWS_BACK; i++) {
    const toBlock = head - BigInt(i) * LOG_WINDOW;
    if (toBlock <= 0n) break;
    const fromBlock = toBlock > LOG_WINDOW ? toBlock - LOG_WINDOW : 0n;
    try {
      const logs = await publicClient.getLogs({
        address: getArcMessageTransmitter(),
        event: MESSAGE_RECEIVED_EVENT,
        args: { nonce },
        fromBlock,
        toBlock,
      });
      if (logs[0]?.transactionHash) return logs[0].transactionHash;
    } catch (e) {
      // An RPC that refuses the query tells us nothing about whether the mint
      // happened — usedNonces already answered that. Never let a log-provider
      // limitation propagate: the caller is deciding how to record an arrival,
      // not whether one occurred.
      console.warn(
        `[cctp] getLogs [${fromBlock}, ${toBlock}] refused: ` +
          `${(e as Error).message.split("\n")[0]}`
      );
      return null;
    }
    if (fromBlock === 0n) break;
  }
  return null;
}

/// Resolve an already-delivered message to the transaction that delivered it, or
/// null when the chain will not tell us.
///
/// This used to throw, on the reasoning that there was "nothing truthful to
/// record". That reasoning was backwards: usedNonces has already proved the funds
/// are on Arc, and throwing turned an ARRIVED payment into one that retries
/// forever and reads as pending to the payer and the developer. A missing
/// reference is a smaller lie than a missing payment. Settle, and say loudly that
/// the reference could not be resolved.
async function settledElsewhere(publicClient: ArcClient, nonce: Hex): Promise<Hex | null> {
  const hash = await findMintTx(publicClient, nonce);
  if (hash) {
    console.log(`[cctp] message ${nonce} was already minted on Arc by ${hash} — treating as delivered`);
    return hash;
  }
  console.warn(
    `[cctp] message ${nonce} IS minted on Arc (usedNonces confirms it) but its ` +
      `MessageReceived log could not be read — either it is outside the ` +
      `${LOG_WINDOWS_BACK * Number(LOG_WINDOW)}-block lookback, or this RPC does not serve ` +
      `eth_getLogs. Settling without a settlement reference. The funds arrived; only the ` +
      `transaction hash is missing. Point ARC_${isMainnet() ? "MAINNET" : "TESTNET"}_RPC_URL at a provider that serves logs ` +
      `to stop losing these references.`
  );
  return null;
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
export async function receiveOnArc(att: CctpAttestation): Promise<Hex | null> {
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

/**
 * Refuse to call a CCTP contract that is not there.
 *
 * The EVM returns success for a call to an address with no code. That is why
 * a mainnet deployment pointed at the testnet TokenMessenger did not fail: it
 * "burned" 0.98 USDC, emitted no message, reported success, and left the
 * payment waiting for an attestation that could never exist.
 *
 * One eth_getCode before the first burn on a chain turns that into an error
 * naming the address and the variable that sets it. It is cached because the
 * answer cannot change for a deployed contract, so this costs one call per
 * chain per process, not one per payment.
 */
const codeChecked = new Map<string, boolean>();

export async function assertCctpContract(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any,
  address: Address,
  what: string,
  envVar: string
): Promise<void> {
  const chainId = publicClient?.chain?.id ?? "?";
  const key = `${chainId}:${address.toLowerCase()}`;
  if (codeChecked.get(key)) return;

  /**
   * A FAILED READ IS NOT AN EMPTY ONE.
   *
   * The first version of this collapsed both into `catch(() => undefined)`,
   * and a rate-limited RPC immediately made it refuse the CORRECT mainnet
   * TokenMessenger — telling the operator to change a variable that was right.
   * A guard that cries wolf on a blip is worse than no guard, because the
   * first thing it teaches is to ignore it.
   *
   * So the read is retried, and the two outcomes carry different messages: one
   * says the contract is absent, the other says the check could not be made.
   */
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const code = await publicClient.getCode({ address });
      if (code && code !== "0x") {
        codeChecked.set(key, true);
        return;
      }
      // A successful read of an empty address. This is the real failure.
      throw new Error(
        `${what} at ${address} has no code on chain ${chainId}. A call to it would ` +
          `succeed and do nothing, so the burn would emit no CCTP message and the ` +
          `attestation would never arrive. This is almost always a testnet address on ` +
          `a mainnet deployment — set ${envVar}, or check ARC_NETWORK.`
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes("has no code")) throw e;
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }

  throw new Error(
    `Could not verify ${what} at ${address} on chain ${chainId} — the node did not ` +
      `answer eth_getCode after 3 attempts (${lastErr instanceof Error ? lastErr.message.split("\n")[0] : String(lastErr)}). ` +
      `This says nothing about ${envVar}; it is an RPC problem. Refusing rather than ` +
      `burning into an address that has not been checked.`
  );
}
