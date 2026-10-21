/**
 * Redeem grants from an EOA that has been upgraded under EIP-7702.
 *
 * WHY THIS EXISTS BESIDE THE MSCA PATH
 *
 * An MSCA delegate buys one thing: its address is a function of a factory, a
 * salt and the INITIAL owner, so the owner can be replaced later and the
 * address — written into every grant — stays. That is worth a great deal when
 * a key leaks.
 *
 * It costs a great deal of machinery for it. ~134k of fixed EntryPoint
 * overhead per pass, an ETH deposit the owner has to keep topped up, initCode
 * on first use, and a bundler or a self-bundler to carry the operation. Every
 * one of those was a production failure on mainnet before a single charge
 * settled.
 *
 * A 7702 account gets the batching without any of it. The delegate IS the
 * EOA's address, the implementation executes calls on its behalf, and the
 * transaction is an ordinary one the owner sends and pays for. No EntryPoint,
 * no deposit, no initCode.
 *
 * WHAT IT GIVES UP
 *
 * Rotation. A 7702 account's address is its key's address, so a leaked key
 * cannot be replaced without re-granting from every payer. That is the whole
 * trade, made deliberately.
 *
 * And the delegation indicator is a signature, not code: anyone holding the
 * key can point the account somewhere else, which is why billing/delegation-
 * watch.ts exists and why it has already found six delegations nobody asked
 * for on the testnet keys.
 *
 * WHAT THE GRANT SEES
 *
 * Nothing changes. DelegationManager checks msg.sender against the grant's
 * delegate, and when the account executes on its own behalf msg.sender is the
 * EOA's address either way. A grant naming this EOA can be redeemed by a
 * plain direct call or by this batch, whichever is cheaper that day.
 */

import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { rpcUrlForChain } from "./delegation";
import { getRelayerAccount } from "./signers";
import { withNonce } from "./nonce";

/**
 * MetaMask's EIP7702StatelessDeleGator.
 *
 * Verified deployed at this address on Base, Arbitrum and Optimism mainnet,
 * 11,185 bytes on each — the same implementation, so one constant serves all
 * three. It exposes ERC-7579 `execute(bytes32,bytes)`, which is what carries
 * the batch.
 *
 * Pinned rather than configurable because the address is baked into every
 * authorization this file signs: pointing it elsewhere silently changes what
 * the delegate account IS, and that is not a thing to leave to an environment
 * variable.
 */
export const DELEGATOR_IMPL: Address = "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b";

/// The 7702 indicator an upgraded account carries: 0xef0100 ++ implementation.
const INDICATOR_PREFIX = "0xef0100";

/**
 * ERC-7579 execution mode for a batch.
 *
 * CALLTYPE_BATCH (0x01) in the first byte, everything else zero. The single
 * mode (0x00…) packs its call differently, and a batch of one is still a
 * batch — so this path only ever uses this one, and there is no second
 * encoding to get wrong.
 */
const BATCH_MODE: Hex = `0x01${"00".repeat(31)}`;

const EXECUTE_ABI = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "mode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/// What ERC-7579 expects inside a batch: a tuple array, ABI-encoded.
const EXECUTION_TUPLE = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "callData", type: "bytes" },
    ],
  },
] as const;

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

/** Off unless explicitly switched on. This changes who redeems a grant. */
export function delegate7702Enabled(): boolean {
  return process.env.DELEGATE_7702_ENABLED === "true";
}

function clientsFor(chainId: number, owner: LocalAccount) {
  const rpc = rpcUrlForChain(chainId);
  const chain = defineChain({
    id: chainId,
    name: String(chainId),
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  return {
    publicClient: createPublicClient({ chain, transport: http(rpc) }),
    wallet: createWalletClient({ account: owner, chain, transport: http(rpc) }),
    chain,
  };
}

/**
 * Whether this account already points at our implementation.
 *
 * Three outcomes, and they are not the same. Plain EOA means we must sign an
 * authorization. Pointing at US means we must not — re-authorizing costs gas
 * and a nonce for nothing. Pointing ELSEWHERE means something or someone has
 * taken the account over, and executing through it would run code we did not
 * choose, so that refuses.
 */
export async function delegationState(
  chainId: number,
  owner: LocalAccount
): Promise<"none" | "ours" | "foreign"> {
  const { publicClient } = clientsFor(chainId, owner);
  const code = await publicClient.getCode({ address: owner.address });
  if (!code || code === "0x") return "none";
  const want = concat([INDICATOR_PREFIX as Hex, DELEGATOR_IMPL]).toLowerCase();
  return code.toLowerCase() === want ? "ours" : "foreign";
}

export interface Redeem7702Item {
  delegationManager: Address;
  context: Hex;
  mode: Hex;
  executionCallData: Hex;
  /** Caller's own id for this item, echoed back in the results map. */
  ref: string;
}

export interface Redeem7702Result {
  txHash: Hex;
  /** One entry per item. False means that redemption reverted inside the batch. */
  results: Map<string, { success: boolean }>;
}

/**
 * Redeem a batch of grants in ONE ordinary transaction.
 *
 * The account calls `execute` on itself; the delegated implementation runs
 * each redemption in turn. No EntryPoint, no deposit, no UserOperation.
 *
 * UNLIKE THE 4337 PATH, ONE FAILURE FAILS THE BATCH. handleOps runs each
 * operation independently and charges for it, so a batch of twenty where one
 * grant's period was already spent settles nineteen. A 7579 batch is a single
 * transaction: if one inner call reverts, the whole thing reverts and nothing
 * settles.
 *
 * So the caller must not hand this a grant it has not already checked. The
 * renewal pass filters on status and period before it gets here, which is
 * what makes a batch safe — and why the result map reports all-or-nothing
 * rather than per-item success it cannot actually observe.
 */
export async function redeemBatchVia7702(input: {
  chainId: number;
  owner: LocalAccount;
  items: Redeem7702Item[];
}): Promise<Redeem7702Result> {
  if (input.items.length === 0) {
    return { txHash: "0x" as Hex, results: new Map() };
  }

  const { publicClient, wallet, chain } = clientsFor(input.chainId, input.owner);

  const state = await delegationState(input.chainId, input.owner);
  if (state === "foreign") {
    const code = await publicClient.getCode({ address: input.owner.address });
    throw new Error(
      `${input.owner.address} on chain ${input.chainId} is delegated to something other than ` +
        `${DELEGATOR_IMPL} (code ${code?.slice(0, 24)}…). Refusing to execute through an ` +
        `implementation this deployment did not choose — see billing/delegation-watch.ts.`
    );
  }

  const executions = input.items.map((i) => ({
    target: i.delegationManager,
    value: 0n,
    callData: encodeFunctionData({
      abi: REDEEM_DELEGATIONS_ABI,
      functionName: "redeemDelegations",
      args: [[i.context], [i.mode], [i.executionCallData]],
    }),
  }));

  const data = encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: "execute",
    args: [BATCH_MODE, encodeAbiParameters(EXECUTION_TUPLE, [executions])],
  });

  /**
   * The authorization rides along only when the account is not yet upgraded.
   *
   * Sending one every time would work and would waste a nonce and gas on each
   * pass. `executor: "self"` because the account signing the authorization is
   * also the one sending the transaction, which viem needs told explicitly —
   * without it the nonce it signs over is wrong by one and the authorization
   * is silently ignored, leaving a plain EOA and a reverting call.
   */
  const authorizationList =
    state === "none"
      ? [
          await wallet.signAuthorization({
            account: input.owner,
            contractAddress: DELEGATOR_IMPL,
            executor: "self",
          }),
        ]
      : undefined;

  const txHash = await withNonce(input.owner.address, input.chainId, publicClient, (nonce) =>
    wallet.sendTransaction({
      to: input.owner.address,
      data,
      nonce,
      chain,
      ...(authorizationList ? { authorizationList } : {}),
    })
  );

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const ok = receipt.status === "success";

  /**
   * All-or-nothing, and said so honestly.
   *
   * The 4337 path reads UserOperationEvent per operation because the
   * EntryPoint emits one. Here there is a single transaction and a single
   * status, so claiming per-item outcomes would be inventing them.
   */
  const results = new Map<string, { success: boolean }>();
  for (const i of input.items) results.set(i.ref, { success: ok });

  console.log(
    `[delegate/7702] ${input.owner.address} chain ${input.chainId} redeemed ${input.items.length} ` +
      `in one tx ${ok ? "" : "— REVERTED "}${txHash}` +
      (authorizationList ? " (upgraded this account in the same transaction)" : "")
  );

  return { txHash, results };
}

/// Emitted by the DelegationManager on a successful redemption; used by tests
/// and by anything that wants to confirm a batch did what it claimed.
export const REDEEMED_EVENT = parseAbiItem(
  "event RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, bytes32 indexed delegationHash)"
);

export { decodeEventLog };

/**
 * The signing account behind a 7702 delegate address, or null.
 *
 * Mirrors ownerOfDelegateMsca: the caller passes whatever address the GRANT
 * names and gets back the key that can act as it, or null meaning "not a 7702
 * delegate of ours, redeem it some other way".
 *
 * A grant is immutable, so the address it names is what decides which path
 * runs — never the current configuration. That is what lets MSCA grants and
 * 7702 grants coexist while the switch is in progress, and why this matches
 * on the address rather than on the flag alone.
 */
export function ownerFor7702Delegate(delegate: Address): LocalAccount | null {
  if (!delegate7702Enabled()) return null;
  for (const mode of ["hosted", "external"] as const) {
    let account: LocalAccount;
    try {
      account = getRelayerAccount(mode);
    } catch {
      continue; // key not configured for this role
    }
    if (account.address.toLowerCase() === delegate.toLowerCase()) return account;
  }
  return null;
}
