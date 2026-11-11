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
import { accountForDelegate, getRelayerAccount, getRelayerAddress, getSettlementAddress } from "./signers";
import { delegateAddressForNewGrant, ownerOfDelegateMsca, redeemViaSelfBundler } from "./delegate-msca";
import { withNonce } from "./nonce";
import { chainKeyForId, getSourceChain } from "../gateway/chains";

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

export function rpcUrlForChain(chainId: number): string {
  const url = process.env[`DELEGATION_RPC_${chainId}`];
  if (!url) {
    throw new Error(`No RPC for chain ${chainId} — set DELEGATION_RPC_${chainId}`);
  }
  return url;
}

/** The relayer that holds the delegate role. Its address MUST equal the
 *  `delegate` the wallet granted to (VITE_RENEWAL_DELEGATE_ADDRESS). */
/// Public address the subscriber must delegate to — surfaced to checkout so the
/// grant names the right delegate. Equals the relayer that submits redeemDelegations.
export function getDelegateAddress(): Address {
  return delegateAddressForNewGrant("hosted");
}

// `delegate` is the address a mandate was actually granted to. Passing it is what
// lets a redeem sign with the key that mandate names, rather than whichever relayer
// happens to be the current default — grants are immutable, so old mandates keep
// pointing at the key they were signed for. Omit it for sends that are not
// redeeming a mandate (bridge legs, ERC-3009 pulls), which use the hosted relayer.
function clientsFor(chainId: number, delegate?: Address) {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrlForChain(chainId)] } },
  });
  const account = delegate ? accountForDelegate(delegate) : getRelayerAccount("hosted");
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

/**
 * The execution calldata and mode a periodic-transfer redeem uses.
 *
 * Exported so a BATCHED redeem builds byte-identical calldata to the single
 * one. Two code paths each encoding "transfer this much to that address" is
 * exactly the kind of duplication that drifts and then reverts on chain for
 * reasons nobody can see in a diff.
 */
export function periodicTransferExecution(
  token: Address,
  recipient: Address,
  amount: bigint
): { executionCallDatas: Hex[]; mode: Hex } {
  return {
    executionCallDatas: [packCall(transferCall(token, recipient, amount))],
    mode: SINGLE_DEFAULT_MODE,
  };
}

/**
 * A batch item that settles a period in two: fee to the treasury, remainder
 * to the creator.
 *
 * Both calldatas go into ONE redeemDelegations for this item, so they revert
 * together — see redeemSplitTransfer, which does the same for a lone
 * redemption. Across items a batch stays independent, which is what you want:
 * one subscriber's spent period should not block twenty others.
 *
 * Throws rather than returning a bad split, because the caller is mid-batch
 * and a silently wrong share would be indistinguishable from a correct one.
 */
export function splitTransferExecution(
  token: Address,
  creator: Address,
  treasury: Address,
  periodAmount: bigint,
  fee: bigint
): { executionCallDatas: Hex[]; mode: Hex } {
  if (fee < 0n) throw new Error("fee cannot be negative");
  if (fee > periodAmount) {
    throw new Error(`fee ${fee} exceeds the period amount ${periodAmount}`);
  }
  const creatorShare = periodAmount - fee;
  if (creatorShare <= 0n) {
    throw new Error(`the fee would leave the creator nothing from ${periodAmount}`);
  }
  return {
    executionCallDatas: [
      ...(fee > 0n ? [packCall(transferCall(token, treasury, fee))] : []),
      packCall(transferCall(token, creator, creatorShare)),
    ],
    mode: SINGLE_DEFAULT_MODE,
  };
}

function packCall(call: { target: Address; value: bigint; callData: Hex }): Hex {
  return encodePacked(["address", "uint256", "bytes"], [call.target, call.value, call.callData]);
}

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
/**
 * Redeem one grant as one or more calls, in ONE redeemDelegations.
 *
 * Several calls means several transfers that stand or fall together: the
 * DelegationManager runs every caveat for every entry and reverts the lot if
 * any one is refused. That is what a split settlement needs — fee to the
 * treasury and the remainder to the creator must not be able to half-happen,
 * and batching two UserOperations would allow exactly that, because the
 * EntryPoint charges and reports each operation on its own.
 *
 * The same context is repeated once per call. The period enforcer caps the
 * SUM across them, so two transfers totalling one period pass where three
 * totalling two periods would not.
 */
async function redeemCalls(
  chainId: number,
  delegationManager: Address,
  context: Hex,
  calls: { target: Address; value: bigint; callData: Hex }[],
  delegate?: Address
): Promise<RedeemResult> {
  if (calls.length === 0) throw new Error("redeemCalls called with no calls");
  const executionCallDatas = calls.map(packCall);
  const contexts = calls.map(() => context);
  const modes = calls.map(() => SINGLE_DEFAULT_MODE);
  const executionCallData = executionCallDatas[0]!;

  /**
   * A grant naming one of our MSCAs is redeemed by submitting a UserOperation
   * ourselves, not by signing a transaction as the delegate.
   *
   * Driven by the GRANT, never by configuration. A grant is immutable and
   * DelegationManager checks msg.sender against the delegate it names, so the
   * address in the grant is the only thing that can decide this. Turning the
   * flag off does not make an MSCA-delegated grant redeemable the old way, and
   * turning it on does not change how an EOA-delegated grant is redeemed.
   */
  if (delegate) {
    const held = ownerOfDelegateMsca(delegate);
    if (held) {
      const { txHash, blockNumber } = await redeemViaSelfBundler({
        chainId,
        delegationManager,
        redemptions: executionCallDatas.map((d) => ({
          context,
          executionCallData: d,
          mode: SINGLE_DEFAULT_MODE,
        })),
        delegate,
        owner: held.owner,
      });
      return { txHash, blockNumber };
    }
  }

  const { account, publicClient, walletClient } = clientsFor(chainId, delegate);
  // Simulate first so a revert surfaces its actual reason (and raw bytes) — the
  // most common cause is the subscriber's smart account not being deployed on this
  // source chain (empty revert). selectPaymentChain should already exclude those.
  const sim = await publicClient
    .simulateContract({
      address: delegationManager,
      abi: DELEGATION_MANAGER_ABI,
      functionName: "redeemDelegations",
      args: [contexts, modes, executionCallDatas],
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
  const txHash = await withNonce(account.address, chainId, publicClient, (nonce) =>
    walletClient.writeContract({ ...sim.request, gas, nonce })
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`redeemDelegations reverted: ${txHash}`);
  }
  return { txHash, blockNumber: receipt.blockNumber };
}

/**
 * Refuse a grant whose account still has to be deployed before it can be
 * redeemed from.
 *
 * ERC-7715 returns `accountMeta` — a factory and its calldata — when the
 * delegator account is counterfactual, and the redeemer is expected to carry
 * it on the FIRST redeem. We store it as RenewalDelegation.dependencies and
 * have never used it, because with MetaMask it is always empty: MetaMask
 * performs the EIP-7702 upgrade in its own flow and refuses to let a dapp
 * relay the authorization, so by the time a signed delegation exists the
 * account is already deployed. Verified on chain — the payer EOA behind the
 * live mandates carries 0xef0100-63c0c19a… (MetaMask's stateless delegator,
 * 11,185 bytes) on Base, Arbitrum and Optimism alike.
 *
 * SO THIS IS NOT THE DEPLOYMENT CODE. Writing that would mean maintaining a
 * path that cannot be triggered or tested against the only wallet in play.
 * This makes the dead branch LOUD instead: the day a wallet with a genuinely
 * counterfactual account appears — a passkey or embedded wallet that deploys
 * on first use, which is exactly the shape of the deferred Circle
 * user-wallets plan — the redeem refuses by name rather than reverting inside
 * the DelegationManager, which is an afternoon of tracing.
 *
 * Takes the whole row so a caller cannot forget to select the column: an
 * undefined `dependencies` means it was not loaded, and that is reported
 * rather than read as "none".
 */
export function assertAccountDeployed(grant: {
  grantId?: string | null;
  chainId?: number;
  dependencies?: unknown;
}): void {
  const deps = grant.dependencies;
  if (deps === undefined) {
    throw new Error(
      `grant ${grant.grantId ?? "?"}: dependencies was not selected, so whether this account ` +
        `still needs deploying is unknown. Select it before redeeming.`
    );
  }
  if (Array.isArray(deps) && deps.length > 0) {
    throw new Error(
      `grant ${grant.grantId ?? "?"} on chain ${grant.chainId ?? "?"} carries ${deps.length} ` +
        `ERC-7715 account dependency(ies): its delegator account is not deployed yet and this ` +
        `path does not deploy it. The first redeem must carry the factory calldata. No funds ` +
        `moved.`
    );
  }
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
  /**
   * The address this mandate was granted to, from RenewalDelegation.delegateAddress.
   * Omit only when no stored mandate is involved — a grant's delegate is fixed at
   * signature time, so a redeem must use the key that address names.
   */
  delegate?: Address;
}

/// Redeem one period as `transfer(recipient, amount)` from the subscriber.
export async function redeemPeriodicTransfer(input: PeriodicTransferInput): Promise<RedeemResult> {
  return redeemCalls(
    input.chainId,
    input.delegationManager,
    input.context,
    [transferCall(input.token, input.recipient, input.amount)],
    input.delegate
  );
}

export interface SplitTransferInput extends Omit<PeriodicTransferInput, "recipient" | "amount"> {
  /** The creator's payout wallet — pinned as a payee when the grant was signed. */
  creator: Address;
  /** The platform treasury — the other pinned payee. */
  treasury: Address;
  /** One full period. `fee` comes out of it; the creator gets the remainder. */
  periodAmount: bigint;
  /** The platform's cut of `periodAmount`. Zero is allowed and skips its call. */
  fee: bigint;
}

/**
 * Settle one period wallet-to-wallet: fee to the treasury, remainder to the
 * creator, in ONE redeemDelegations.
 *
 * THE FEE GOES FIRST. Both transfers are in a single call and revert
 * together, so the order cannot decide who loses out — but the order is the
 * one the plan asked for, and it reads correctly in a block explorer: the
 * platform takes its cut out of the period, then the creator is paid what is
 * left.
 *
 * NOTHING REACHES THE PLATFORM'S RELAYER. The grant pins both destinations
 * (see lib/chain/direct-settlement.ts), so this call can only pay those two
 * addresses — and the relayer, which submits it, is not one of them. That is
 * the difference between this and the path it replaces, where the period was
 * transferred to the relayer and bridged.
 */
export async function redeemSplitTransfer(input: SplitTransferInput): Promise<RedeemResult> {
  if (input.fee < 0n) throw new Error("fee cannot be negative");
  if (input.fee > input.periodAmount) {
    throw new Error(`fee ${input.fee} exceeds the period amount ${input.periodAmount}`);
  }
  const creatorShare = input.periodAmount - input.fee;
  if (creatorShare <= 0n) {
    throw new Error(
      `the fee would leave the creator nothing from a period of ${input.periodAmount}`
    );
  }
  const calls = [
    ...(input.fee > 0n ? [transferCall(input.token, input.treasury, input.fee)] : []),
    transferCall(input.token, input.creator, creatorShare),
  ];
  return redeemCalls(input.chainId, input.delegationManager, input.context, calls, input.delegate);
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

// DelegationManager reads used to identify a delegation and ask whether the
// subscriber has since turned it off.
const DELEGATION_STATE_ABI = [
  {
    type: "function",
    name: "getDelegationHash",
    stateMutability: "pure",
    inputs: [{ type: "tuple", components: DELEGATION_ABI_PARAMS[0].components }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "disabledDelegations",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface DelegationIdentity {
  /// uint256 salt as a decimal string — unique per delegation, decoded locally.
  salt: string | null;
  /// DelegationManager.getDelegationHash(delegation), or null if the read failed.
  delegationHash: string | null;
}

/**
 * Identify the delegation inside a permission context.
 *
 * Stored at grant time so a reconciliation pass can ask `disabledDelegations`
 * directly, rather than decoding and re-hashing every stored blob on each sweep.
 *
 * The hash comes from the manager rather than a hand-rolled EIP-712 encoding on
 * purpose: getting a typehash subtly wrong produces a plausible-looking value
 * that silently matches nothing, and we would not find out for months.
 *
 * NEVER throws. A grant is a subscriber signing in their wallet; failing it
 * because an RPC blinked would be a poor trade for a column the reconciler can
 * backfill later.
 */
export async function delegationIdentity(
  chainId: number,
  delegationManager: Address,
  context: Hex
): Promise<DelegationIdentity> {
  let decoded;
  try {
    [decoded] = decodeAbiParameters(DELEGATION_ABI_PARAMS, context);
  } catch {
    return { salt: null, delegationHash: null };
  }
  const delegation = decoded[0];
  if (!delegation) return { salt: null, delegationHash: null };
  const salt = String(delegation.salt);

  try {
    const { publicClient } = clientsFor(chainId);
    const hash = await publicClient.readContract({
      address: delegationManager,
      abi: DELEGATION_STATE_ABI,
      functionName: "getDelegationHash",
      args: [delegation],
    });
    return { salt, delegationHash: hash as string };
  } catch (e) {
    console.warn(
      `[delegation] could not hash delegation on chain ${chainId} — storing salt only: ` +
        `${e instanceof Error ? e.message.split("\n")[0] : String(e)}`
    );
    return { salt, delegationHash: null };
  }
}

/// Has the subscriber turned this delegation off in their own wallet? Only the
/// delegator can, and nothing notifies us, so the only way to know is to ask.
export async function isDelegationDisabled(
  chainId: number,
  delegationManager: Address,
  delegationHash: Hex
): Promise<boolean> {
  const { publicClient } = clientsFor(chainId);
  return (await publicClient.readContract({
    address: delegationManager,
    abi: DELEGATION_STATE_ABI,
    functionName: "disabledDelegations",
    args: [delegationHash],
  })) as boolean;
}

/**
 * Can an existing mandate carry a new charge, or must the subscriber sign again?
 *
 * Both conditions matter and only one is obvious. A cap below the price fails at
 * redeem with `over_cap`, which is the loud case. A mismatched period is quieter
 * and worse: a daily mandate against a monthly plan looks fine, redeems once,
 * then refuses for the rest of the month because the enforcer permits one
 * transfer per period — and the period it enforces is the one that was SIGNED,
 * not the one the plan wants.
 *
 * Treating a non-covering mandate as coverage is how a subscriber ends up told
 * "already authorized" for a plan their signature cannot actually pay for.
 */
export function mandateCovers(
  mandate: { periodAmount: bigint; periodDuration: number },
  amount: bigint,
  periodDuration: number
): boolean {
  return mandate.periodAmount >= amount && mandate.periodDuration === periodDuration;
}

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
