/**
 * Redeem a grant whose delegate is one of our own MSCAs, without a bundler.
 *
 * WHAT THIS REPLACES
 *
 * redeemSingle has always sent redeemDelegations as an ordinary transaction
 * signed by the delegate key itself: simulate, bound the gas estimate so a
 * testnet RPC's block-sized answer does not get rejected, take a nonce from the
 * Postgres counter, send, wait. That works and is simple, and it has two costs.
 *
 * The delegate address cannot be rotated. It is written into every grant's
 * delegation struct and DelegationManager checks msg.sender against it, so a
 * new key means every existing grant becomes unredeemable. And every redeem
 * queues behind one sequential nonce per chain — which is what nonce.ts and its
 * Postgres lock exist for.
 *
 * An MSCA delegate fixes both: its address is derived from a factory and a
 * salt, so the owner key can be replaced while the address stays, and
 * EntryPoint nonces are two-dimensional.
 *
 * WHY NO BUNDLER
 *
 * An MSCA is reachable only through the EntryPoint — its validation plugin
 * answers NotImplemented(bytes4,uint8) to a runtime call of execute(). That is
 * usually read as needing a bundler service, but handleOps(ops[], beneficiary)
 * is permissionless: anyone may submit, and the beneficiary is reimbursed from
 * the sender account's deposit. Measured on Base Sepolia, submitting it
 * ourselves is FASTER than the ordinary transaction it replaces — 1.5s for a
 * batch of four against 11.3s for four transactions, and faster than the
 * 6.9-12.1s observed through a public bundler, most of which was queueing.
 *
 * Gas is a fixed premium rather than a per-operation one: about 134k once per
 * batch plus 38.5k per operation, against 37.4k for a plain transaction. So a
 * batch never wins on total gas and always wins on latency, by a margin that
 * grows with the batch.
 *
 * WHAT IT COSTS
 *
 * Two ETH balances per chain instead of one. handleOps pays the beneficiary out
 * of the SENDER's EntryPoint deposit, so the MSCA needs a deposit and the
 * submitter needs working capital. The owner EOA serves as submitter — it is
 * the same key, it already holds ETH on every source chain, and it never
 * appears in a grant, so net burn is unchanged and nothing new needs funding.
 *
 * And we own the gas limits. No bundler estimates them, and the EntryPoint
 * demands the deposit covers their sum before it runs anything.
 */

import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  parseAbiItem,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { getUserOperationHash, toPackedUserOperation } from "viem/account-abstraction";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { getRelayerAccount, type RelayerMode } from "./signers";
import { rpcUrlForChain } from "./delegation";
import { withNonce } from "./nonce";
import { delegate7702Enabled } from "./delegate-7702";

const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

/**
 * Decoded rather than matched by a hardcoded topic hash.
 *
 * The literal is right — checked — but a constant nobody can read is a
 * constant nobody notices going stale, and `success` is the field that decides
 * whether a payment happened.
 */
const USER_OP_EVENT = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"
);

const ENTRY_POINT_ABI = [
  {
    name: "handleOps",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "ops",
        type: "tuple[]",
        components: [
          { name: "sender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" },
          { name: "accountGasLimits", type: "bytes32" },
          { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" },
          { name: "paymasterAndData", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "beneficiary", type: "address" },
    ],
    outputs: [],
  },
  { name: "depositTo", type: "function", stateMutability: "payable", inputs: [{ name: "account", type: "address" }], outputs: [] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "getNonce", type: "function", stateMutability: "view", inputs: [{ name: "sender", type: "address" }, { name: "key", type: "uint192" }], outputs: [{ type: "uint256" }] },
] as const;

const MSCA_EXECUTE_ABI = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "bytes" }],
  },
] as const;

/**
 * Gas limits, chosen rather than estimated.
 *
 * redeemDelegations through an MSCA's execute() is heavier than the plain call:
 * the plugin validates, then the DelegationManager runs every caveat enforcer.
 * These are deliberately generous because unused gas returns to the deposit
 * while too little reverts the whole batch — and a reverted batch is a renewal
 * that did not happen.
 */
const REDEEM_DELEGATIONS_ABI = [
  {
    name: "redeemDelegations",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "permissionContexts", type: "bytes[]" },
      { name: "modes", type: "bytes32[]" },
      { name: "executionCallDatas", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

const CALL_GAS = 700_000n;
const VERIFICATION_GAS = 300_000n;
const PRE_VERIFICATION_GAS = 80_000n;

/** Keep this much ETH deposited at the EntryPoint for each delegate MSCA. */
function depositFloor(): bigint {
  const raw = process.env.DELEGATE_MSCA_DEPOSIT_FLOOR_ETH;
  if (!raw) return parseEther("0.002");
  try {
    const v = parseEther(raw);
    return v > 0n ? v : parseEther("0.002");
  } catch {
    return parseEther("0.002");
  }
}

/**
 * The initCode that deploys this account, or "0x" when it already exists.
 *
 * The self-bundler omitted this entirely, so every UserOperation it sent named
 * a sender that had no code. The EntryPoint rejects that in validation with
 * AA20 — an early revert, no logs, ~72k gas — which is what a mainnet redeem
 * did twice on 2026-10-21 while the deposit sat funded and untouched.
 *
 * It never showed on testnet because those delegate MSCAs had been deployed by
 * earlier probes, and an account only needs initCode once.
 *
 * Returning "0x" for a deployed account is not an optimisation: sending
 * initCode for an account that exists is AA10, so this has to be read from the
 * chain each time rather than cached.
 */
async function initCodeFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  account: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any
): Promise<Hex> {
  const code = await publicClient.getCode({ address: account.address }).catch(() => undefined);
  if (code && code !== "0x") return "0x";
  const args = await account.getFactoryArgs?.();
  if (!args?.factory || !args?.factoryData) {
    throw new Error(
      `${account.address} is not deployed and the account exposes no factory args, so the ` +
        `UserOperation cannot deploy it. Deploy it once, or redeem through a bundler.`
    );
  }
  return concat([args.factory as Hex, args.factoryData as Hex]);
}

/**
 * Confirm a deposit landed, by its OUTCOME rather than its receipt.
 *
 * waitForTransactionReceipt alone abandoned a working payment on 2026-10-21:
 * the deposit transaction took over three minutes on Base, viem gave up, and
 * the charge failed — while the ETH had in fact arrived. The EntryPoint held
 * exactly the amount the log said it was depositing.
 *
 * A receipt is evidence of the deposit, not the thing we need. What we need is
 * the balance being sufficient, and that can be read directly. So: wait for
 * the receipt, and if that times out or the transaction was replaced, poll the
 * deposit instead. A slow L2 inclusion should delay a payment, never fail it.
 */
async function confirmDeposit(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any;
  hash: Hex;
  account: Address;
  required: bigint;
}): Promise<void> {
  const readDeposit = async (): Promise<bigint> =>
    (await opts.publicClient.readContract({
      address: ENTRY_POINT,
      abi: ENTRY_POINT_ABI,
      functionName: "balanceOf",
      args: [opts.account],
    })) as bigint;

  try {
    const r = await opts.publicClient.waitForTransactionReceipt({ hash: opts.hash });
    if (r.status === "success") return;
    // A reverted deposit is a real failure, but check anyway: a replacement
    // may have carried the same value through under a different hash.
  } catch {
    /* timed out, or replaced — the balance decides, not the receipt */
  }

  // Up to two more minutes, which is generous for an L2 and still bounded.
  for (let i = 0; i < 24; i++) {
    if ((await readDeposit()) >= opts.required) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }

  throw new Error(
    `EntryPoint deposit for ${opts.account} did not arrive: ${opts.hash} never confirmed and the ` +
      `deposit is still under the ${formatEther(opts.required)} needed. The ETH may yet land — ` +
      `check the deposit before re-funding the owner.`
  );
}

/**
 * How much to actually deposit, given what the owner can afford.
 *
 * depositFloor() is a target, not a requirement, and treating it as one broke
 * a mainnet charge: the owners held ~0.00008 ETH each while the floor asked
 * for 0.002, so depositTo reverted on `value` with viem's generic "total cost
 * exceeds the balance of the account" — which names no account and no number
 * and reads like the wallet is empty.
 *
 * So: aim for the floor, settle for what is there, and refuse only when even
 * the operation's own gas cannot be covered. A small balance should mean
 * frequent small top-ups, not a hard stop.
 *
 * `reserve` keeps back enough for the deposit transaction itself, which is
 * paid by the same account that is funding the deposit.
 */
function topUpAmount(opts: {
  required: bigint;
  ownerBalance: bigint;
  maxFeePerGas: bigint;
  owner: Address;
  chainId: number;
}): bigint {
  const reserve = opts.maxFeePerGas * 100_000n;
  const affordable = opts.ownerBalance > reserve ? opts.ownerBalance - reserve : 0n;
  if (affordable < opts.required) {
    throw new Error(
      `delegate owner ${opts.owner} holds ${formatEther(opts.ownerBalance)} ETH on chain ` +
        `${opts.chainId}, which after ${formatEther(reserve)} for this transaction's own gas ` +
        `leaves ${formatEther(affordable)} — under the ${formatEther(opts.required)} the operation ` +
        `needs. Fund that address; it is the owner, not the smart account.`
    );
  }
  const floor = depositFloor();
  return affordable < floor ? affordable : floor;
}

/** Off unless explicitly switched on. This changes who redeems a grant. */
export function delegateMscaEnabled(): boolean {
  return process.env.DELEGATE_MSCA_ENABLED === "true";
}

/**
 * The MSCA address for a delegate role, pinned in config.
 *
 * toCircleSmartAccount derives it with an RPC round trip, and neither the grant
 * path nor the redeem path should make a network call to learn an address that
 * never changes. Identical on every chain. Derive it with
 * scripts/delegate-msca-address.ts.
 */
export function delegateMscaAddress(mode: RelayerMode): Address | null {
  const raw =
    mode === "external"
      ? process.env.EXTERNAL_RELAYER_MSCA_ADDRESS
      : process.env.RENEWAL_DELEGATE_MSCA_ADDRESS;
  if (!raw) return null;
  try {
    return raw as Address;
  } catch {
    return null;
  }
}

/**
 * The address a NEW grant should name as its delegate.
 *
 * Deliberately separate from getRelayerAddress(), which answers "what address
 * does this key have" and is used for things that are not grants. This answers
 * "who should the subscriber delegate to", and those stop being the same
 * address the moment an MSCA is in play.
 */
export function delegateAddressForNewGrant(mode: RelayerMode): Address {
  const msca = delegateMscaAddress(mode);
  /**
   * A 7702 account's address IS its key's address, so a grant naming it names
   * the EOA — the same address this returns with the MSCA off.
   *
   * Both flags on is not a preference to resolve, it is a contradiction: the
   * two paths write DIFFERENT addresses into grants, and picking one silently
   * would make a batch of grants unredeemable by whichever path lost. It
   * refuses instead, at the moment a grant would be minted rather than later
   * when one cannot be collected.
   */
  if (delegate7702Enabled()) {
    if (delegateMscaEnabled() && msca) {
      throw new Error(
        "DELEGATE_7702_ENABLED and DELEGATE_MSCA_ENABLED are both true. They pin different " +
          "delegate addresses into grants. Set exactly one."
      );
    }
    return getRelayerAccount(mode).address;
  }
  return delegateMscaEnabled() && msca ? msca : getRelayerAccount(mode).address;
}

/**
 * The key that owns `delegate`, if `delegate` is one of our MSCAs.
 *
 * Returns null for anything else, including our own delegate EOAs — the caller
 * uses that to mean "redeem the old way". A grant is immutable, so the address
 * it names is what decides which path runs, never the current configuration.
 */
export function ownerOfDelegateMsca(delegate: Address): { owner: LocalAccount; mode: RelayerMode } | null {
  const want = delegate.toLowerCase();
  for (const mode of ["hosted", "external"] as RelayerMode[]) {
    const msca = delegateMscaAddress(mode);
    if (msca && msca.toLowerCase() === want) {
      return { owner: getRelayerAccount(mode) as unknown as LocalAccount, mode };
    }
  }
  return null;
}

/** 16 bytes each, high then low — the packed v0.7 layout. */
function packTwo(high: bigint, low: bigint): Hex {
  return `0x${high.toString(16).padStart(32, "0")}${low.toString(16).padStart(32, "0")}` as Hex;
}

export interface SelfBundledRedeemInput {
  chainId: number;
  delegationManager: Address;
  /** The grant's permission context, redeemed as-is. */
  context: Hex;
  /** Already-encoded single-call execution data, as redeemSingle builds it. */
  executionCallData: Hex;
  /** The mode encoded in SINGLE_DEFAULT_MODE by the caller. */
  mode: Hex;
  /** The MSCA the grant names, and the key that owns it. */
  delegate: Address;
  owner: LocalAccount;
}

/**
 * Redeem one grant by submitting a UserOperation ourselves.
 *
 * One operation per call, matching redeemSingle's shape. Batching several into
 * one handleOps is the larger win and is a separate change — it needs the
 * renewal pass restructured to collect due grants before submitting, rather
 * than redeeming each as it walks them.
 */
export async function redeemViaSelfBundler(
  input: SelfBundledRedeemInput
): Promise<{ txHash: Hex; blockNumber: bigint }> {
  const rpc = rpcUrlForChain(input.chainId);
  const chain = defineChain({
    id: input.chainId,
    name: `chain-${input.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const submitter = createWalletClient({ account: input.owner, chain, transport: http(rpc) });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account = await toCircleSmartAccount({ client: publicClient as any, owner: input.owner as any });
  if (account.address.toLowerCase() !== input.delegate.toLowerCase()) {
    throw new Error(
      `grant names delegate ${input.delegate} but the owner key derives MSCA ${account.address} — ` +
        `refusing to redeem. The configured address or the owner key is wrong.`
    );
  }

  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;

  /**
   * The EntryPoint pays the submitter out of the SENDER's deposit, so a thin
   * deposit fails the operation rather than slowing it. Topped up from the
   * owner's own ETH — the same balance that used to pay for this redeem
   * directly — so this moves where the ETH sits without needing a new key.
   */
  const required = (CALL_GAS + VERIFICATION_GAS + PRE_VERIFICATION_GAS) * maxFeePerGas;
  const deposit = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: ENTRY_POINT_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (deposit < required) {
    const ownerBalance = await publicClient.getBalance({ address: input.owner.address });
    const top = topUpAmount({
      required,
      ownerBalance,
      maxFeePerGas,
      owner: input.owner.address,
      chainId: input.chainId,
    });
    console.warn(
      `[delegate/self-bundler] ${account.address} deposit ${formatEther(deposit)} ETH is under the ` +
        `${formatEther(required)} this operation needs — depositing ${formatEther(top)} from ${input.owner.address}`
    );
    const hash = await withNonce(input.owner.address, input.chainId, publicClient, (nonce) =>
      submitter.sendTransaction({
        to: ENTRY_POINT,
        value: top,
        data: encodeFunctionData({ abi: ENTRY_POINT_ABI, functionName: "depositTo", args: [account.address] }),
        nonce,
      })
    );
    await confirmDeposit({ publicClient, hash, account: account.address, required });
  }

  const redeemCall = encodeFunctionData({
    abi: REDEEM_DELEGATIONS_ABI,
    functionName: "redeemDelegations",
    args: [[input.context], [input.mode], [input.executionCallData]],
  });

  const callData = encodeFunctionData({
    abi: MSCA_EXECUTE_ABI,
    functionName: "execute",
    args: [input.delegationManager, 0n, redeemCall],
  });

  const nonce = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: ENTRY_POINT_ABI,
    functionName: "getNonce",
    args: [account.address, 0n],
  });

  const unpacked = {
    sender: account.address,
    nonce,
    callData,
    callGasLimit: CALL_GAS,
    verificationGasLimit: VERIFICATION_GAS,
    preVerificationGas: PRE_VERIFICATION_GAS,
    maxFeePerGas,
    maxPriorityFeePerGas,
    signature: "0x" as Hex,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signature = await account.signUserOperation(unpacked as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = toPackedUserOperation({ ...unpacked, signature } as any);

  const op = {
    sender: p.sender,
    nonce: p.nonce,
    initCode: (p.initCode ?? (await initCodeFor(account, publicClient))) as Hex,
    callData: p.callData,
    accountGasLimits: packTwo(VERIFICATION_GAS, CALL_GAS),
    preVerificationGas: PRE_VERIFICATION_GAS,
    gasFees: packTwo(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: (p.paymasterAndData ?? "0x") as Hex,
    signature: p.signature,
  };

  /**
   * The submitter is an ordinary EOA sending an ordinary transaction, so it
   * still takes a nonce from the Postgres counter — the 2D nonce gain belongs
   * to the MSCA, and is only realised once several operations ride in one
   * handleOps.
   */
  const txHash = await withNonce(input.owner.address, input.chainId, publicClient, (n) =>
    submitter.sendTransaction({
      to: ENTRY_POINT,
      data: encodeFunctionData({ abi: ENTRY_POINT_ABI, functionName: "handleOps", args: [[op], input.owner.address] }),
      gas: CALL_GAS + VERIFICATION_GAS + PRE_VERIFICATION_GAS + 200_000n,
      nonce: n,
    })
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`handleOps reverted redeeming ${input.delegate}: ${txHash}`);
  }

  /**
   * handleOps succeeding is not the operation succeeding.
   *
   * A UserOperation whose call reverts still produces a successful handleOps —
   * the EntryPoint charges for it and emits UserOperationEvent with
   * success=false. Treating the transaction receipt as the answer would report
   * a collected payment that never moved any money, so the event is what
   * decides.
   */
  const decoded = receipt.logs
    .filter((l) => l.address.toLowerCase() === ENTRY_POINT.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: [USER_OP_EVENT], data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find((d) => d?.eventName === "UserOperationEvent");

  if (!decoded) {
    throw new Error(`handleOps mined with no UserOperationEvent — cannot confirm the redeem: ${txHash}`);
  }
  const { success } = decoded.args as { success: boolean };
  if (!success) {
    throw new Error(`redeemDelegations reverted inside handleOps: ${txHash}`);
  }

  return { txHash, blockNumber: receipt.blockNumber };
}


export interface BatchRedeemItem {
  delegationManager: Address;
  context: Hex;
  executionCallData: Hex;
  mode: Hex;
  /** The caller's own identifier, used to hand results back. */
  ref: string;
}

export interface BatchRedeemOutcome {
  txHash: Hex;
  blockNumber: bigint;
  /** One entry per item, keyed by its ref. Absent means no event was found. */
  results: Map<string, { success: boolean }>;
}

/**
 * Redeem several grants in ONE transaction.
 *
 * This is where self-bundling pays for itself. An MSCA delegate costs about
 * 134k of fixed overhead plus 38.5k per operation, measured, so a single
 * redeem runs 172k against the 37k an EOA transaction used. Batched, the fixed
 * part amortises: 5 due renewals come to 65k each, 20 to 45k, 50 to 41k. The
 * ERC-4337 premium that buys a rotatable delegate address is paid once per
 * pass rather than once per subscriber.
 *
 * ONE OPERATION FAILING DOES NOT FAIL THE OTHERS, which is the whole reason
 * this returns a map instead of throwing. The EntryPoint runs each operation
 * independently, charges for it, and reports its own success — so a batch of
 * twenty where one grant's period was already spent settles nineteen. Results
 * are matched by userOpHash, the indexed topic on UserOperationEvent, rather
 * than by position: the EntryPoint is not obliged to emit in submission order,
 * and guessing would attribute one subscriber's failure to another.
 */
export async function redeemBatchViaSelfBundler(input: {
  chainId: number;
  delegate: Address;
  owner: LocalAccount;
  items: BatchRedeemItem[];
}): Promise<BatchRedeemOutcome> {
  if (input.items.length === 0) throw new Error("redeemBatchViaSelfBundler called with no items");

  const rpc = rpcUrlForChain(input.chainId);
  const chain = defineChain({
    id: input.chainId,
    name: `chain-${input.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const submitter = createWalletClient({ account: input.owner, chain, transport: http(rpc) });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account = await toCircleSmartAccount({ client: publicClient as any, owner: input.owner as any });
  if (account.address.toLowerCase() !== input.delegate.toLowerCase()) {
    throw new Error(
      `grants name delegate ${input.delegate} but the owner key derives MSCA ${account.address} — refusing to redeem`
    );
  }

  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;

  // The EntryPoint checks the deposit covers EVERY operation's worst case before
  // running any of them, so this scales with the batch.
  const perOp = (CALL_GAS + VERIFICATION_GAS + PRE_VERIFICATION_GAS) * maxFeePerGas;
  const required = perOp * BigInt(input.items.length);
  const deposit = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: ENTRY_POINT_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (deposit < required) {
    const ownerBalance = await publicClient.getBalance({ address: input.owner.address });
    // Three operations' worth when affordable, so a batch is not one deposit
    // per op; topUpAmount caps it at what the owner actually holds.
    const want = required * 3n;
    const top = topUpAmount({
      required: want > required ? required : want,
      ownerBalance,
      maxFeePerGas,
      owner: input.owner.address,
      chainId: input.chainId,
    });
    console.warn(
      `[delegate/self-bundler] ${account.address} deposit ${formatEther(deposit)} ETH under the ` +
        `${formatEther(required)} needed for ${input.items.length} ops — depositing ${formatEther(top)}`
    );
    const hash = await withNonce(input.owner.address, input.chainId, publicClient, (nonce) =>
      submitter.sendTransaction({
        to: ENTRY_POINT,
        value: top,
        data: encodeFunctionData({ abi: ENTRY_POINT_ABI, functionName: "depositTo", args: [account.address] }),
        nonce,
      })
    );
    await confirmDeposit({ publicClient, hash, account: account.address, required });
  }

  // Sequential nonces in key 0. handleOps validates every operation before it
  // executes any, and each validation bumps the account's nonce, so N+0, N+1 …
  // in one batch is legal — confirmed on chain rather than assumed.
  const startNonce = await publicClient.readContract({
    address: ENTRY_POINT,
    abi: ENTRY_POINT_ABI,
    functionName: "getNonce",
    args: [account.address, 0n],
  });

  type PackedOp = {
    sender: Address;
    nonce: bigint;
    initCode: Hex;
    callData: Hex;
    accountGasLimits: Hex;
    preVerificationGas: bigint;
    gasFees: Hex;
    paymasterAndData: Hex;
    signature: Hex;
  };
  const ops: PackedOp[] = [];
  const hashToRef = new Map<string, string>();
  // Read once: every op in this batch shares one account, and the answer
  // cannot change mid-loop.
  const batchInitCode = await initCodeFor(account, publicClient);

  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i]!;
    const redeemCall = encodeFunctionData({
      abi: REDEEM_DELEGATIONS_ABI,
      functionName: "redeemDelegations",
      args: [[item.context], [item.mode], [item.executionCallData]],
    });
    const callData = encodeFunctionData({
      abi: MSCA_EXECUTE_ABI,
      functionName: "execute",
      args: [item.delegationManager, 0n, redeemCall],
    });
    const unpacked = {
      sender: account.address,
      nonce: startNonce + BigInt(i),
      callData,
      callGasLimit: CALL_GAS,
      verificationGasLimit: VERIFICATION_GAS,
      preVerificationGas: PRE_VERIFICATION_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas,
      signature: "0x" as Hex,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signature = await account.signUserOperation(unpacked as any);
    const signed = { ...unpacked, signature };

    const userOpHash = getUserOperationHash({
      chainId: input.chainId,
      entryPointAddress: ENTRY_POINT,
      entryPointVersion: "0.7",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userOperation: signed as any,
    });
    hashToRef.set(userOpHash.toLowerCase(), item.ref);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = toPackedUserOperation(signed as any);
    ops.push({
      sender: p.sender,
      nonce: p.nonce,
      // First op only: handleOps validates all before executing any, so op 1's
      // initCode deploys the account and a second one would be AA10.
      initCode: (p.initCode ?? (i === 0 ? batchInitCode : "0x")) as Hex,
      callData: p.callData,
      accountGasLimits: packTwo(VERIFICATION_GAS, CALL_GAS),
      preVerificationGas: PRE_VERIFICATION_GAS,
      gasFees: packTwo(maxPriorityFeePerGas, maxFeePerGas),
      paymasterAndData: (p.paymasterAndData ?? "0x") as Hex,
      signature: p.signature,
    });
  }

  const outerGas =
    (CALL_GAS + VERIFICATION_GAS + PRE_VERIFICATION_GAS) * BigInt(input.items.length) + 300_000n;

  const txHash = await withNonce(input.owner.address, input.chainId, publicClient, (n) =>
    submitter.sendTransaction({
      to: ENTRY_POINT,
      data: encodeFunctionData({
        abi: ENTRY_POINT_ABI,
        functionName: "handleOps",
        args: [ops, input.owner.address],
      }),
      gas: outerGas,
      nonce: n,
    })
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`handleOps reverted for the whole batch on chain ${input.chainId}: ${txHash}`);
  }

  const results = new Map<string, { success: boolean }>();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ENTRY_POINT.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: [USER_OP_EVENT], data: log.data, topics: log.topics });
      if (d.eventName !== "UserOperationEvent") continue;
      const { userOpHash, success } = d.args as { userOpHash: Hex; success: boolean };
      const ref = hashToRef.get(userOpHash.toLowerCase());
      if (ref) results.set(ref, { success });
    } catch {
      // Not a UserOperationEvent. The EntryPoint emits others.
    }
  }

  console.log(
    `[delegate/self-bundler] chain ${input.chainId}: ${input.items.length} redeems in one tx, ` +
      `${[...results.values()].filter((r) => r.success).length} succeeded — ${txHash}`
  );

  return { txHash, blockNumber: receipt.blockNumber, results };
}
