// Tier-2 redeem adapter — the autonomous side of ERC-7710.
//
// After the subscriber's one-time ERC-7715 grant, the relayer (delegate) renews
// each cycle by calling `DelegationManager.redeemDelegations(...)` on the chain
// the mandate lives on. The on-chain `erc20PeriodTransfer` caveat enforcer caps
// every redemption to one period's amount and resets per period — so even a
// compromised relayer key cannot pull more than one cycle.
//
// viem 2.23 ships no ERC-7710 helper, so we call the manager directly with a
// minimal ABI and hand-encode the ERC-7579 batch execution calldata.
//
// NOTE: ERC-7710/7715 is used ONLY for renewals (the autonomous per-cycle pull).
// The cross-chain FIRST payment does not use delegation — it uses an ERC-3009
// transferWithAuthorization (relayerPullViaAuthorization, below) + CCTP V2.

import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  defineChain,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  pad,
  size,
  slice,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TOKEN_MESSENGER_ABI, burnParams, type BurnSpeed } from "../gateway/cctp";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

// Only the redemption entrypoint of the ERC-7710 DelegationManager.
export const DELEGATION_MANAGER_ABI = [
  {
    type: "function",
    name: "redeemDelegations",
    stateMutability: "nonpayable",
    inputs: [
      { name: "permissionContexts", type: "bytes[]" },
      { name: "modes", type: "bytes32[]" },
      { name: "executionCallDatas", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

function rpcUrlForChain(chainId: number): string {
  const url = process.env[`DELEGATION_RPC_${chainId}`];
  if (!url) {
    throw new Error(`No RPC for chain ${chainId} — set DELEGATION_RPC_${chainId}`);
  }
  return url;
}

/** The relayer that holds the delegate role. Its address MUST equal the
 *  `delegate` the wallet granted to (VITE_RENEWAL_DELEGATE_ADDRESS). */
function getDelegateAccount() {
  const pk = process.env.RENEWAL_DELEGATE_PRIVATE_KEY ?? process.env.PLATFORM_PRIVATE_KEY;
  if (!pk) throw new Error("RENEWAL_DELEGATE_PRIVATE_KEY / PLATFORM_PRIVATE_KEY not set");
  return privateKeyToAccount(pk as Hex);
}

/// Public address the subscriber must delegate to — surfaced to checkout so the
/// grant names the right delegate. Equals the relayer that submits redeemDelegations.
export function getDelegateAddress(): Address {
  return getDelegateAccount().address;
}

function clientsFor(chainId: number) {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrlForChain(chainId)] } },
  });
  const account = getDelegateAccount();
  return {
    account,
    publicClient: createPublicClient({ chain, transport: http() }),
    walletClient: createWalletClient({ account, chain, transport: http() }),
  };
}

/// Bounded gas limit for a relayer-paid tx. Some testnet RPCs return an inflated
/// estimate (≈ the whole block gas limit), which the sequencer then rejects with
/// "intrinsic gas too high / exceeds the block limit". We buffer the estimate by
/// 25% but cap it to 90% of the current block's gas limit so the relayer's tx
/// always fits in a block; if estimation fails we fall back to a fixed limit.
async function boundedGas(
  publicClient: ReturnType<typeof clientsFor>["publicClient"],
  estimate: () => Promise<bigint>,
  fallback = 250_000n
): Promise<bigint> {
  let cap: bigint;
  try {
    cap = ((await publicClient.getBlock({ blockTag: "latest" })).gasLimit * 9n) / 10n;
  } catch {
    return fallback;
  }
  try {
    const buffered = ((await estimate()) * 125n) / 100n;
    return buffered < cap ? buffered : cap;
  } catch {
    return fallback < cap ? fallback : cap;
  }
}

// Surface the actual revert bytes from a viem ContractFunctionExecutionError so a
// failure is decodable later (e.g. an enforcer custom-error selector) instead of a
// useless "reverted for an unknown reason". An empty revert has no raw data.
function revertDetail(e: unknown): string {
  const x = e as {
    shortMessage?: string;
    message?: string;
    signature?: string;
    cause?: { raw?: string; data?: unknown; signature?: string };
  };
  const raw =
    x.cause?.raw ??
    x.cause?.signature ??
    (typeof x.cause?.data === "string" ? x.cause.data : undefined) ??
    x.signature;
  const short = x.shortMessage ?? x.message?.split("\n")[0] ?? String(e);
  return raw ? `${short} [raw: ${raw}]` : short;
}

export interface RedeemResult {
  txHash: Hex;
  blockNumber: bigint;
}

// ─── 7715 periodic-transfer redeem (the C1 primitive) ────────────────────────
//
// MetaMask end-user wallets only grant ERC-7715 transfer-type permissions, and
// the ERC20PeriodTransfer enforcer accepts ONLY a single `transfer` execution
// (CallType SINGLE; a batch reverts `invalid-call-type`). So the relayer redeems
// the subscriber's periodic mandate as one `transfer(recipient, amount)` — used
// both to settle on Arc (recipient = creator) and to pull a period to the relayer
// on a source chain before it bridges via CCTP.

// ERC-7579 single-call mode: CallType SINGLE (0x00) + default ExecType (0x00).
// executionCallData for single mode is abi.encodePacked(target, value, callData).
const SINGLE_DEFAULT_MODE =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

function transferCall(token: Address, recipient: Address, amount: bigint) {
  return {
    target: token,
    value: 0n,
    callData: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [recipient, amount],
    }),
  };
}

/// Shared single-call redeem: execute one call FROM the subscriber's account,
/// bounded by the periodic enforcer in the granted context.
async function redeemSingle(
  chainId: number,
  delegationManager: Address,
  context: Hex,
  call: { target: Address; value: bigint; callData: Hex }
): Promise<RedeemResult> {
  const { account, publicClient, walletClient } = clientsFor(chainId);
  const executionCallData = encodePacked(
    ["address", "uint256", "bytes"],
    [call.target, call.value, call.callData]
  );
  // Simulate first so a revert surfaces its actual reason (and raw bytes) — the
  // most common cause is the subscriber's smart account not being deployed on this
  // source chain (empty revert). selectPaymentChain should already exclude those.
  const sim = await publicClient
    .simulateContract({
      address: delegationManager,
      abi: DELEGATION_MANAGER_ABI,
      functionName: "redeemDelegations",
      args: [[context], [SINGLE_DEFAULT_MODE], [executionCallData]],
      account,
    })
    .catch((e) => {
      throw new Error(`redeemDelegations reverted on chain ${chainId}: ${revertDetail(e)}`);
    });
  // Cap the gas to fit the block — without this, some testnet RPCs return a
  // block-sized estimate the sequencer rejects ("exceeds the limit allowed for
  // the block"). redeemDelegations is heavier than a plain transfer, so the
  // fallback is generous.
  const gas = await boundedGas(
    publicClient,
    () =>
      publicClient.estimateContractGas({
        address: delegationManager,
        abi: DELEGATION_MANAGER_ABI,
        functionName: "redeemDelegations",
        args: [[context], [SINGLE_DEFAULT_MODE], [executionCallData]],
        account,
      }),
    600_000n
  );
  const txHash = await walletClient.writeContract({ ...sim.request, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`redeemDelegations reverted: ${txHash}`);
  }
  return { txHash, blockNumber: receipt.blockNumber };
}

export interface PeriodicTransferInput {
  chainId: number;
  delegationManager: Address;
  context: Hex;
  /** USDC on `chainId`. */
  token: Address;
  /** Where the period is transferred — creator (Arc settle) or relayer (source pull). */
  recipient: Address;
  /** One period's amount — must be ≤ the enforcer's per-period cap. */
  amount: bigint;
}

/// Redeem one period as `transfer(recipient, amount)` from the subscriber.
export async function redeemPeriodicTransfer(input: PeriodicTransferInput): Promise<RedeemResult> {
  return redeemSingle(
    input.chainId,
    input.delegationManager,
    input.context,
    transferCall(input.token, input.recipient, input.amount)
  );
}

/// Diagnostic: SIMULATE the periodic transfer redeem — confirms the granted 7715
/// mandate redeems as a single transfer (no funds move). Used by the dev harness.
export async function simulatePeriodicTransfer(
  input: PeriodicTransferInput
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { account, publicClient } = clientsFor(input.chainId);
    const call = transferCall(input.token, input.recipient, input.amount);
    const executionCallData = encodePacked(
      ["address", "uint256", "bytes"],
      [call.target, call.value, call.callData]
    );
    await publicClient.simulateContract({
      address: input.delegationManager,
      abi: DELEGATION_MANAGER_ABI,
      functionName: "redeemDelegations",
      args: [[input.context], [SINGLE_DEFAULT_MODE], [executionCallData]],
      account,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 800) : String(e) };
  }
}

// ─── Decode the signed cap (the source of truth) ─────────────────────────────
//
// A granted ERC-7715 mandate carries its per-period cap INSIDE the signed
// `context` (the ERC20PeriodTransferEnforcer terms), so that is authoritative —
// the periodAmount/periodDuration columns we store alongside are just a mirror
// the client supplied. We decode the cap back out to (a) reject a grant whose
// cap can't cover the plan price at write time and (b) refuse a redeem that
// would exceed it, instead of letting it revert on-chain.

// `redeemDelegations` permissionContext = abi.encode(Delegation[]).
const DELEGATION_ABI_PARAMS = [
  {
    type: "tuple[]",
    components: [
      { name: "delegate", type: "address" },
      { name: "delegator", type: "address" },
      { name: "authority", type: "bytes32" },
      {
        name: "caveats",
        type: "tuple[]",
        components: [
          { name: "enforcer", type: "address" },
          { name: "terms", type: "bytes" },
          { name: "args", type: "bytes" },
        ],
      },
      { name: "salt", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

export interface PeriodTransferTerms {
  token: Address;
  /** Max transferable per period (token base units) — the on-chain cap. */
  periodAmount: bigint;
  periodDuration: number;
  startDate: number;
}

/// Decode the ERC20PeriodTransferEnforcer terms for `token` out of a signed
/// ERC-7710 context. The enforcer's terms are a fixed 116-byte packed layout
/// (token[20] | periodAmount[32] | periodDuration[32] | startDate[32]); we match
/// the caveat by that shape AND its leading token so we don't have to pin the
/// enforcer address. Returns null if the context carries no such caveat.
export function decodePeriodTransferTerms(context: Hex, token: Address): PeriodTransferTerms | null {
  let delegations: readonly { caveats: readonly { terms: Hex }[] }[];
  try {
    [delegations] = decodeAbiParameters(DELEGATION_ABI_PARAMS, context);
  } catch {
    return null;
  }
  const want = token.toLowerCase();
  for (const d of delegations) {
    for (const c of d.caveats) {
      const terms = c.terms;
      if (size(terms) !== 116) continue;
      if (slice(terms, 0, 20).toLowerCase() !== want) continue;
      return {
        token: getAddress(slice(terms, 0, 20)),
        periodAmount: BigInt(slice(terms, 20, 52)),
        periodDuration: Number(BigInt(slice(terms, 52, 84))),
        startDate: Number(BigInt(slice(terms, 84, 116))),
      };
    }
  }
  return null;
}

/** The parameters that fully determine the burn batch — and therefore the exact
 *  calldata the smart-account delegation pins via its `exactCalldataBatch` caveat. */
export interface BurnCallParams {
  /** USDC on the source chain. */
  token: Address;
  /** CCTP TokenMessenger on the source chain. */
  tokenMessenger: Address;
  /** The amount to MINT on Arc. The relayer burns this PLUS the CCTP maxFee from
   *  its own float, so the recipient receives the full `amount` (the platform
   *  absorbs the bridge fee). */
  amount: bigint;
  /** Arc's CCTP domain. */
  destinationDomain: number;
  /** Address minted to on Arc (the subscriber, or the creator on a renewal). */
  mintRecipient: Address;
  /** Fast (paid soft finality, interactive) or Standard (free, hard finality). */
  speed: BurnSpeed;
}

type Call = { target: Address; value: bigint; callData: Hex };

/// The two calls a cross-chain bridge submits: approve the CCTP TokenMessenger,
/// then depositForBurn toward Arc — sent by the RELAYER from its own funds.
///
/// CCTP deducts the fee from the burned amount, so to land the FULL `input.amount`
/// on Arc we burn `amount + maxFee` (the relayer funds the maxFee from its float).
/// Since the actual fee is ≤ maxFee, the recipient receives at least `amount`.
function burnCalls(input: BurnCallParams): { approve: Call; burn: Call; burnAmount: bigint } {
  const { maxFee, minFinalityThreshold } = burnParams(input.speed, input.amount);
  const burnAmount = input.amount + maxFee;
  const approveCall = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [input.tokenMessenger, burnAmount],
  });
  const burnCall = encodeFunctionData({
    abi: TOKEN_MESSENGER_ABI,
    functionName: "depositForBurn",
    args: [
      burnAmount,
      input.destinationDomain,
      pad(input.mintRecipient, { size: 32 }),
      input.token,
      ZERO_BYTES32, // destinationCaller = anyone (could be pinned to the relayer)
      maxFee,
      minFinalityThreshold,
    ],
  });
  return {
    approve: { target: input.token, value: 0n, callData: approveCall },
    burn: { target: input.tokenMessenger, value: 0n, callData: burnCall },
    burnAmount,
  };
}

export interface RelayerBridgeInput extends BurnCallParams {
  /** Source chain the relayer is bridging FROM (where it just received the period). */
  chainId: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// C1 source-side bridge: the relayer sends its OWN `approve` + `depositForBurn`
/// from funds it just received via the periodic transfer — minting `amount` to
/// `mintRecipient` (the creator) on Arc. Not a delegation redeem. Returns the burn
/// tx hash for the Iris attestation. Brief custody: the relayer holds the period
/// only between the transfer and the burn.
///
/// approve and depositForBurn are two separate txs against a load-balanced public
/// RPC, so a naive back-to-back send races read-your-writes: the burn's gas
/// estimation can hit a node that hasn't yet seen the approve block and revert
/// `ERC20: transfer amount exceeds allowance` before broadcasting. We (1) skip the
/// approve when the allowance already covers `amount` (idempotent on a resumed
/// "pulled" bridge), (2) confirm the approve is actually readable before burning,
/// and (3) retry the burn a few times on that specific stale-read revert.
export async function relayerBridgeToArc(input: RelayerBridgeInput): Promise<{ burnTxHash: Hex }> {
  const { account, publicClient, walletClient } = clientsFor(input.chainId);
  const { approve: approveCall, burn: burnCall, burnAmount } = burnCalls(input);

  const readAllowance = () =>
    publicClient.readContract({
      address: input.token,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [account.address, input.tokenMessenger],
    });

  // 1. Ensure the TokenMessenger is approved for the full burn (amount + fee), and
  //    don't proceed until the approval is visible to the node we'll read from.
  if ((await readAllowance()) < burnAmount) {
    const approveHash = await walletClient.sendTransaction({
      to: approveCall.target,
      value: approveCall.value,
      data: approveCall.callData,
      gas: await boundedGas(publicClient, () =>
        publicClient.estimateGas({ account, to: approveCall.target, value: approveCall.value, data: approveCall.callData })
      ),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (receipt.status !== "success") throw new Error(`relayer approve reverted: ${approveHash}`);
    let confirmed = false;
    for (let i = 0; i < 10; i++) {
      if ((await readAllowance()) >= burnAmount) {
        confirmed = true;
        break;
      }
      await sleep(1_500);
    }
    if (!confirmed) throw new Error("approve mined but allowance not yet visible — retry next pass");
  }

  // 2. Burn, retrying the stale-read revert (allowance is set; a lagging RPC node
  //    may still estimate against pre-approve state).
  for (let attempt = 0; ; attempt++) {
    try {
      const burnHash = await walletClient.sendTransaction({
        to: burnCall.target,
        value: burnCall.value,
        data: burnCall.callData,
        gas: await boundedGas(
          publicClient,
          () => publicClient.estimateGas({ account, to: burnCall.target, value: burnCall.value, data: burnCall.callData }),
          400_000n
        ),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: burnHash });
      if (receipt.status !== "success") throw new Error(`relayer depositForBurn reverted: ${burnHash}`);
      return { burnTxHash: burnHash };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < 4 && msg.includes("transfer amount exceeds allowance")) {
        console.warn(`[billing/tier2] burn saw stale allowance (attempt ${attempt + 1}) — retrying`);
        await sleep(2_000);
        continue;
      }
      throw e;
    }
  }
}

// ─── ERC-3009 gasless pull (first-payment funding) ───────────────────────────
//
// For a cross-chain FIRST payment the subscriber signs an ERC-3009
// `transferWithAuthorization` moving one over-sweep amount of source USDC to the
// relayer (gasless — the relayer submits it and pays source gas). The relayer
// then CCTP-burns those funds to Arc (relayerBridgeToArc). Brief custody only,
// exactly like the renewal pull.

const ERC3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/// Split a 65-byte EOA signature into {v, r, s}.
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const sig = signature.slice(2);
  if (sig.length !== 130) throw new Error("expected a 65-byte signature");
  const r = `0x${sig.slice(0, 64)}` as Hex;
  const s = `0x${sig.slice(64, 128)}` as Hex;
  let v = parseInt(sig.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { v, r, s };
}

export interface PullViaAuthorizationInput {
  chainId: number;
  /** USDC on the source chain. */
  token: Address;
  /** Subscriber (the authorizer). */
  from: Address;
  /** Relayer recipient (getDelegateAddress()). */
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  /** bytes32 authorization nonce echoed from the signed payload. */
  nonce: Hex;
  /** The subscriber's 65-byte ERC-3009 signature. */
  signature: Hex;
}

/// Submit the subscriber's signed ERC-3009 transferWithAuthorization on the source
/// chain (relayer pays gas) — moves `value` USDC subscriber → relayer so it can be
/// CCTP-burned to Arc. Gasless for the subscriber.
export async function relayerPullViaAuthorization(
  input: PullViaAuthorizationInput
): Promise<{ txHash: Hex }> {
  const { account, publicClient, walletClient } = clientsFor(input.chainId);
  const { v, r, s } = splitSignature(input.signature);
  const callParams = {
    address: input.token,
    abi: ERC3009_ABI,
    functionName: "transferWithAuthorization" as const,
    args: [input.from, input.to, input.value, input.validAfter, input.validBefore, input.nonce, v, r, s] as const,
    account,
  };
  const { request } = await publicClient.simulateContract(callParams);
  // Pin a bounded gas limit so an over-estimating RPC can't trip "intrinsic gas
  // too high" — the platform always covers this gas.
  const gas = await boundedGas(publicClient, () => publicClient.estimateContractGas(callParams));
  const txHash = await walletClient.writeContract({ ...request, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`transferWithAuthorization reverted: ${txHash}`);
  return { txHash };
}
