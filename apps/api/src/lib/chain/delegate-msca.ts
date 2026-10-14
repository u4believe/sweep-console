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
import { toPackedUserOperation } from "viem/account-abstraction";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { getRelayerAccount, type RelayerMode } from "./signers";
import { rpcUrlForChain } from "./delegation";
import { withNonce } from "./nonce";

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
    const top = depositFloor();
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
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`EntryPoint deposit failed: ${hash}`);
  }

  const redeemCall = encodeFunctionData({
    abi: [
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
    ] as const,
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
    initCode: (p.initCode ?? "0x") as Hex,
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
