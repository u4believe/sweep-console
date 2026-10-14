/**
 * Settlement as one atomic UserOperation, paying its gas in USDC.
 *
 * Replaces the pair that has always run back to back — relayerBridgeToArc then
 * payFeeToTreasury — with a single ERC-4337 operation containing approve,
 * depositForBurn and the fee transfer. Two things come out of that, and the
 * gas is only one of them.
 *
 * ATOMICITY. The existing path sends approve as its own transaction, then
 * polls the allowance up to ten times waiting for the node it will read from
 * to catch up, then retries the burn through a stale-read revert. None of that
 * is defensive programming gone wrong — it is the real consequence of two
 * transactions needing to agree about state. Inside one UserOperation the
 * window does not exist. The fee transfer joins them, so a payment can no
 * longer burn successfully and then fail to remit, which today is explicitly
 * tolerated as "a reconciliation chore".
 *
 * NO ETH. Circle Paymaster takes the gas in USDC from the account's own
 * balance against an EIP-2612 permit. The settlement wallet needs no native
 * token on any of the three source chains.
 *
 * WHERE THE GAS MONEY COMES FROM
 *
 * Settlement is designed to finish each payment holding nothing, which leaves
 * the paymaster nothing to take. Rather than fund a float by hand, each
 * payment tops the account up toward a floor out of the PLATFORM'S OWN FEE and
 * stops once the floor is reached. The merchant's share is never touched, and
 * an account already at the floor gives up nothing, so this is a one-off cost
 * rather than a running tax.
 *
 * The top-up is computed from the balance that was there BEFORE this payment
 * arrived, never by sweeping the balance — the existing invariant that a
 * concurrent payment's funds are untouchable still holds.
 */

import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  encodePacked,
  getContract,
  http,
  maxUint256,
  parseErc6492Signature,
  type Address,
  type Hex,
} from "viem";
import { createBundlerClient, toSimple7702SmartAccount } from "viem/account-abstraction";
import { burnParams, type BurnSpeed } from "../gateway/cctp";
import { chainKeyForId } from "../gateway/chains";
import { burnCalls, rpcUrlForChain, sourceDomainFor, type BurnCallParams } from "./delegation";
import { getSettlementAccount } from "./signers";
import {
  SIMPLE_7702_IMPLEMENTATION,
  bundlerUrlFor,
  circlePaymasterV08,
  settlementGasFloor,
  settlementPermitCeiling,
} from "./settlement-target";

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const EIP2612_ABI = [
  { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "version", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "nonces",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface SettleUserOpInput extends BurnCallParams {
  chainId: number;
  speed: BurnSpeed;
  /** Everything redeemed into settlement for this payment. */
  grossAmount: bigint;
  /** Where the platform's share goes. */
  treasury: Address;
}

export interface SettleUserOpResult {
  burnTxHash: Hex;
  /** The CCTP fee the burn actually used, for the caller's own accounting. */
  maxFee: bigint;
  /** What reached the treasury — gross, less the merchant, the burn and any top-up. */
  feePaid: bigint;
  /** USDC the paymaster took for gas. Zero only if something is wrong. */
  gasPaid: bigint;
  /** USDC held back to keep the account above the gas floor. */
  toppedUp: bigint;
}

/**
 * Run the whole settlement for one payment as a single UserOperation.
 *
 * `input.amount` is the merchant's share — what must MINT on Arc. The burn
 * takes that plus the CCTP maxFee, exactly as the direct path does, so the
 * merchant receives the full share and the platform absorbs the bridge fee.
 */
export async function settleViaUserOp(input: SettleUserOpInput): Promise<SettleUserOpResult> {
  const chainKey = chainKeyForId(input.chainId);
  const chain = defineChain({
    id: input.chainId,
    name: chainKey ?? `chain-${input.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrlForChain(input.chainId)] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrlForChain(input.chainId)) });

  const owner = getSettlementAccount();
  const account = await toSimple7702SmartAccount({ client: publicClient, owner });

  // The address must not have moved. Every grant that pins settlement as payee
  // depends on it, so this is asserted rather than assumed — a mismatch means
  // funds would be redeemed somewhere this code cannot spend from.
  if (account.address.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(
      `7702 account ${account.address} is not the settlement address ${owner.address} — refusing to settle`
    );
  }

  const sourceDomain = sourceDomainFor(input.chainId);
  const fee = await burnParams(
    input.speed,
    input.amount,
    sourceDomain === undefined
      ? undefined
      : { sourceDomain, destinationDomain: input.destinationDomain }
  );
  const { approve, burn } = burnCalls(input, fee);

  // What settlement held BEFORE this payment landed. Anything above the floor
  // is left alone; anything below it is made up out of this payment's fee.
  const balanceNow = await publicClient.readContract({
    address: input.token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  const preexisting = balanceNow > input.grossAmount ? balanceNow - input.grossAmount : 0n;
  const floor = settlementGasFloor();
  const toppedUp = preexisting >= floor ? 0n : floor - preexisting;

  const platformShare = input.grossAmount - input.amount;
  const feeToTreasury = platformShare - fee.maxFee - toppedUp;

  const calls: { to: Address; data: Hex }[] = [
    { to: approve.target, data: approve.callData },
    { to: burn.target, data: burn.callData },
  ];
  // A share too small to cover the burn and the top-up remits nothing rather
  // than reverting the payment. The money stays in an account we own, which is
  // the same answer payFeeToTreasury has always given to this case.
  if (feeToTreasury > 0n) {
    calls.push({
      to: input.token,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [input.treasury, feeToTreasury] }),
    });
  }

  const paymasterAddress = circlePaymasterV08(input.chainId);
  const permitAmount = settlementPermitCeiling();

  const paymaster = {
    async getPaymasterData() {
      const token = getContract({ client: publicClient, address: input.token, abi: EIP2612_ABI });
      const [name, version, nonce] = await Promise.all([
        token.read.name(),
        token.read.version(),
        token.read.nonces([account.address]),
      ]);
      const wrapped = await account.signTypedData({
        domain: { name, version, chainId: input.chainId, verifyingContract: input.token },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: {
          owner: account.address,
          spender: paymasterAddress,
          value: permitAmount,
          nonce,
          deadline: maxUint256,
        },
      });
      const { signature } = parseErc6492Signature(wrapped);
      return {
        paymaster: paymasterAddress,
        paymasterData: encodePacked(
          ["uint8", "address", "uint256", "bytes"],
          [0, input.token, permitAmount, signature]
        ),
        paymasterVerificationGasLimit: 200_000n,
        /// 15_000, which viem's guide uses, is rejected with PostOpGasLimitTooLow.
        paymasterPostOpGasLimit: 65_000n,
        isFinal: true,
      };
    },
  };

  const bundler = createBundlerClient({
    account,
    chain,
    client: publicClient,
    paymaster,
    transport: http(bundlerUrlFor(input.chainId)),
    userOperation: {
      /**
       * Bundlers set their own floors and do not agree on them: Arbitrum via
       * Pimlico rejects a priority fee under 120000 wei where Base and OP
       * accept zero, and says only "Invalid fields set on User Operation"
       * about it. Asking beats assuming, and the fallback keeps this working
       * with a provider that has no such method.
       */
      estimateFeesPerGas: async ({ bundlerClient }) => {
        try {
          const price = (await bundlerClient.request({
            method: "pimlico_getUserOperationGasPrice",
          } as never)) as { standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
          return {
            maxFeePerGas: BigInt(price.standard.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(price.standard.maxPriorityFeePerGas),
          };
        } catch {
          const fees = await publicClient.estimateFeesPerGas();
          return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
        }
      },
    },
  });

  /**
   * Delegate if, and only if, the account is not already pointing at OUR
   * implementation.
   *
   * "Has code" is the wrong question, and asking it that way is what the first
   * version of this did. The settlement key on Base Sepolia was already
   * delegated — to MetaMask's EIP7702StatelessDeleGator v1.3.0, picked up at
   * some point from connecting the address in a wallet. That contract is bound
   * to EntryPoint v0.7, so a v0.8 operation reaches it and reverts with
   * NotEntryPoint(), surfacing as the unhelpful "AA23 reverted 0xd663742a".
   * Skipping the authorization because code was present is precisely how a
   * settlement would have failed in production.
   *
   * A 7702 delegation pointer is 23 bytes: 0xef0100 followed by the
   * implementation address. Comparing that tail is the real check.
   *
   * signAuthorization is the one method a remote signer must add beyond
   * `sign`: viem's toAccount() does not provide it, so a KMS-backed owner
   * lacking it fails here rather than at startup.
   */
  const code = await publicClient.getCode({ address: account.address });
  const wanted = account.authorization.address.toLowerCase();

  // The monitor expects this exact implementation without building an account,
  // so a viem upgrade that moves it must not pass silently here.
  if (wanted !== SIMPLE_7702_IMPLEMENTATION.toLowerCase()) {
    throw new Error(
      `viem delegates to ${wanted} but SIMPLE_7702_IMPLEMENTATION says ` +
        `${SIMPLE_7702_IMPLEMENTATION} — update the constant, or delegation-watch will ` +
        `report every settlement account as hijacked`
    );
  }
  const delegatedTo =
    code && code.toLowerCase().startsWith("0xef0100") ? `0x${code.slice(8)}`.toLowerCase() : null;

  if (delegatedTo && delegatedTo !== wanted) {
    console.warn(
      `[settlement/userop] ${account.address} is delegated to ${delegatedTo}, not ${wanted} — re-delegating. ` +
        `Anything relying on the previous implementation stops working at this address.`
    );
  }

  const authorization =
    delegatedTo === wanted
      ? undefined
      : await owner.signAuthorization({
          address: account.authorization.address,
          chainId: input.chainId,
          nonce: await publicClient.getTransactionCount({ address: account.address }),
        });

  const hash = await bundler.sendUserOperation({
    account,
    ...(authorization ? { authorization } : {}),
    calls,
  });
  const receipt = await bundler.waitForUserOperationReceipt({ hash });
  if (!receipt.success) {
    throw new Error(`settlement UserOperation reverted: ${receipt.receipt.transactionHash}`);
  }

  // Pinned to the receipt's block. A UserOperation receipt can arrive before
  // the RPC serving this read has caught up, which once had a probe reporting
  // an unchanged balance for a payment that had plainly moved.
  const balanceAfter = await publicClient.readContract({
    address: input.token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
    blockNumber: receipt.receipt.blockNumber,
  });
  const spent = balanceNow - balanceAfter;
  const intended = input.amount + fee.maxFee + (feeToTreasury > 0n ? feeToTreasury : 0n);
  const gasPaid = spent > intended ? spent - intended : 0n;

  console.log(
    `[settlement/userop] ${chainKey ?? input.chainId} burned ${input.amount} (+${fee.maxFee} maxFee), ` +
      `remitted ${feeToTreasury > 0n ? feeToTreasury : 0n}, topped up ${toppedUp}, gas ${gasPaid} USDC — ` +
      receipt.receipt.transactionHash
  );

  return {
    burnTxHash: receipt.receipt.transactionHash,
    maxFee: fee.maxFee,
    feePaid: feeToTreasury > 0n ? feeToTreasury : 0n,
    gasPaid,
    toppedUp,
  };
}

