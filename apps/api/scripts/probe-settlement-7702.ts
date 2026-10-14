// Settlement as an EIP-7702 account on EntryPoint v0.8, paying gas in USDC.
//
//   pnpm tsx scripts/probe-settlement-7702.ts                 # Base Sepolia
//   pnpm tsx scripts/probe-settlement-7702.ts --chain optimism
//   pnpm tsx scripts/probe-settlement-7702.ts --chain arbitrum
//   pnpm tsx scripts/probe-settlement-7702.ts --fund          # just the address
//
// WHY THIS EXISTS ALONGSIDE probe-settlement-paymaster.ts
//
// That one uses Circle's modular wallet, which is pinned to EntryPoint v0.7 —
// the SDK defines only ENTRY_POINT_07, and a deployed account agrees. Circle
// Paymaster reaches Optimism only at v0.8, so Circle's own wallet cannot use
// Circle's own paymaster there. This probe is the way round that.
//
// THE PROPERTY THAT MATTERS, AND IT IS NOT THE GAS
//
// A 7702 account's address IS the EOA's address. Measured, not assumed: owner
// and account both come back 0xf734B712….
//
// So delegating the EXISTING settlement EOA leaves its address untouched, and
// every grant that pins it as payee keeps working — including the 14 of 27 that
// would otherwise be stranded on the old path until late 2027. The modular
// wallet buys 7 grants and a year of waiting; this buys all 27 at once.
//
// WHAT IT COSTS
//
// Circle's bundler is v0.7 only. Asked directly, eth_supportedEntryPoints
// returns just 0x0000000071727De22E5E9d8BAf0edAc6f37da032 on Base Sepolia,
// OP Sepolia and Arbitrum Sepolia alike. So v0.8 means a third-party bundler.
// This probe uses Pimlico's public endpoint, which is fine for a probe and is
// not what production should point at — see BUNDLER_URL below.
//
// It also gives up Circle's addOwners recovery: a 7702 account's address is its
// key's address, so rotating the key still moves the address. KMS protects the
// key; nothing here makes it rotatable.

import "dotenv/config";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getContract,
  http,
  maxUint256,
  parseErc6492Signature,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createBundlerClient, toSimple7702SmartAccount } from "viem/account-abstraction";

/**
 * Circle Paymaster v0.8. One address per network generation, not per chain.
 *
 * Verified on chain rather than taken from the docs table: on testnet this
 * holds 1.6708 ETH of EntryPoint v0.8 deposit on Base Sepolia, 1.6782 on OP
 * Sepolia and 2.4599 on Arbitrum Sepolia, each configured for that chain's own
 * USDC. The mainnet equivalent is 0x0578cFB2…, deployed and unpaused on OP
 * Mainnet, Base Mainnet and Arbitrum One.
 */
const PAYMASTER_V08_TESTNET: Address = "0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966";

type ChainCfg = {
  id: number;
  name: string;
  rpc: string;
  usdc: Address;
  tokenMessenger: Address;
};

/// Mirrors the three source chains in lib/gateway/chains.ts, testnet side.
const CHAINS: Record<string, ChainCfg> = {
  base: {
    id: 84532,
    name: "Base Sepolia",
    rpc: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  },
  optimism: {
    id: 11155420,
    name: "OP Sepolia",
    rpc: "https://sepolia.optimism.io",
    usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  },
  arbitrum: {
    id: 421614,
    name: "Arbitrum Sepolia",
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  },
};

/**
 * Public, rate-limited, and unauthenticated — appropriate for a probe and not
 * for settlement. Production wants an account with a bundler provider, and
 * that contract is the real cost of leaving Circle's v0.7 bundler behind.
 */
const BUNDLER_URL = (chainId: number) =>
  process.env.BUNDLER_URL ?? `https://public.pimlico.io/v2/${chainId}/rpc`;

const ARC_DOMAIN = 26;

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const EIP2612_ABI = [
  { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "version", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }], name: "nonces", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const TOKEN_MESSENGER_ABI = [
  {
    name: "depositForBurn",
    type: "function",
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

const toBytes32 = (a: Address): Hex => `0x${"0".repeat(24)}${a.slice(2)}` as Hex;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main(): Promise<void> {
  const which = process.argv.includes("--chain")
    ? process.argv[process.argv.indexOf("--chain") + 1]!
    : "base";
  const cfg = CHAINS[which];
  if (!cfg) throw new Error(`unknown --chain ${which}. One of: ${Object.keys(CHAINS).join(", ")}`);

  const treasury = (process.env.PLATFORM_TREASURY_ADDRESS ?? "") as Address;
  if (!treasury) throw new Error("PLATFORM_TREASURY_ADDRESS is not set");

  const chain = defineChain({
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpc) });
  const owner = privateKeyToAccount(need("PROBE_OWNER_KEY") as Hex);
  const account = await toSimple7702SmartAccount({ client: publicClient, owner });

  const [usdc0, eth0, code0] = await Promise.all([
    publicClient.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
    publicClient.getBalance({ address: account.address }),
    publicClient.getCode({ address: account.address }),
  ]);
  // Re-read after the send, pinned to the receipt's block — see below.

  console.log(`${cfg.name} (${cfg.id})`);
  console.log(`  account      ${account.address}   (identical to the owner EOA)`);
  console.log(`  entryPoint   v${account.entryPoint.version}  ${account.entryPoint.address}`);
  console.log(`  USDC         ${formatUnits(usdc0, 6)}`);
  console.log(`  ETH          ${formatUnits(eth0, 18)}${eth0 === 0n ? "   <- zero, which is the point" : "   <- NOT zero, a pass proves less"}`);

  const burnAmount = parseUnits(process.env.PROBE_BURN ?? "0.10", 6);
  const feeAmount = parseUnits(process.env.PROBE_FEE ?? "0.01", 6);
  const permitAmount = parseUnits(process.env.PROBE_PERMIT ?? "0.20", 6);

  if (process.argv.includes("--fund")) {
    console.log(`\nSend USDC (and no ETH) to ${account.address}, then run again.`);
    return;
  }
  const required = burnAmount + feeAmount + parseUnits("0.05", 6);
  if (usdc0 < required) {
    console.log(`\nNeeds at least ${formatUnits(required, 6)} USDC. Use --fund for the address,`);
    console.log("or shrink the run with PROBE_BURN / PROBE_FEE.");
    return;
  }

  /**
   * Circle Paymaster, addressed directly.
   *
   * No API and no client key — unlike the v0.7 probe, nothing here talks to
   * Circle at all. The permit signature IS the paymasterData.
   */
  const paymaster = {
    async getPaymasterData() {
      const token = getContract({ client: publicClient, address: cfg.usdc, abi: EIP2612_ABI });
      const [name, version, nonce] = await Promise.all([
        token.read.name(),
        token.read.version(),
        token.read.nonces([account.address]),
      ]);
      const wrapped = await account.signTypedData({
        domain: { name, version, chainId: cfg.id, verifyingContract: cfg.usdc },
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
          spender: PAYMASTER_V08_TESTNET,
          value: permitAmount,
          nonce,
          deadline: maxUint256,
        },
      });
      const { signature } = parseErc6492Signature(wrapped);
      return {
        paymaster: PAYMASTER_V08_TESTNET,
        paymasterData: encodePacked(
          ["uint8", "address", "uint256", "bytes"],
          [0, cfg.usdc, permitAmount, signature]
        ),
        paymasterVerificationGasLimit: 200_000n,
        /// 15_000, as viem's guide uses, is rejected with PostOpGasLimitTooLow.
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
    transport: http(BUNDLER_URL(cfg.id)),
    userOperation: {
      /**
       * Ask the bundler what it will accept, and only then the chain.
       *
       * Bundlers set their own floors and do not agree on them. Arbitrum
       * Sepolia via Pimlico rejects anything under 120000 wei of priority fee
       * — "Invalid fields set on User Operation", which says nothing about
       * fees until you read the details — while the same code passes on Base
       * and OP Sepolia with a zero priority fee. That divergence is the cost
       * of a third-party bundler in miniature, and it is why this asks rather
       * than assumes.
       *
       * pimlico_getUserOperationGasPrice is vendor-specific, so a provider
       * that does not implement it falls through to the chain's own estimate.
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
          return {
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          };
        }
      },
    },
  });

  /**
   * The delegation rides along in the first UserOperation.
   *
   * An account with no code is not yet delegated, and EntryPoint v0.8 accepts
   * the authorization inside the operation itself — so there is no separate,
   * ETH-paying transaction to set it up first. That matters: it means a
   * settlement wallet holding nothing but USDC can bootstrap itself.
   */
  const needsAuth = !code0 || code0 === "0x";
  console.log(`  delegation   ${needsAuth ? "not set — riding along in this UserOperation" : "already active"}`);

  const authorization = needsAuth
    ? await owner.signAuthorization({
        address: account.authorization.address,
        chainId: cfg.id,
        nonce: await publicClient.getTransactionCount({ address: account.address }),
      })
    : undefined;

  const calls = [
    { to: cfg.usdc, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [cfg.tokenMessenger, burnAmount] }) },
    {
      to: cfg.tokenMessenger,
      data: encodeFunctionData({
        abi: TOKEN_MESSENGER_ABI,
        functionName: "depositForBurn",
        args: [burnAmount, ARC_DOMAIN, toBytes32(treasury), cfg.usdc, `0x${"0".repeat(64)}` as Hex, 0n, 2000],
      }),
    },
    { to: cfg.usdc, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [treasury, feeAmount] }) },
  ];

  console.log("\nSending approve + depositForBurn + fee transfer as ONE UserOperation …");
  const t0 = Date.now();
  let hash: Hex;
  try {
    hash = await bundler.sendUserOperation({ account, ...(authorization ? { authorization } : {}), calls });
  } catch (e) {
    console.log("\nFAIL at send. That is the answer, not an accident:");
    const err = e as Error & { details?: string; shortMessage?: string };
    console.log(`  ${err.shortMessage ?? err.message.split("\n")[0]}`);
    // The useful sentence is almost always in `details`, not the headline.
    if (err.details) console.log(`  details: ${err.details}`);
    return;
  }

  const receipt = await bundler.waitForUserOperationReceipt({ hash });

  /**
   * Read at the receipt's block, not "now".
   *
   * A UserOperation receipt can arrive before the RPC serving these reads has
   * caught up, and the first run of this probe duly reported an unchanged
   * balance for a transaction that had in fact moved 0.067386 USDC. Pinning
   * the block makes the numbers deterministic instead of a race, which a
   * sleep would only have made less likely rather than impossible.
   */
  const at = receipt.receipt.blockNumber;
  const [usdc1, eth1, code1] = await Promise.all([
    publicClient.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address], blockNumber: at }),
    publicClient.getBalance({ address: account.address, blockNumber: at }),
    publicClient.getCode({ address: account.address, blockNumber: at }),
  ]);

  const moved = burnAmount + feeAmount;
  const spent = usdc0 - usdc1;
  const gas = spent > moved ? spent - moved : 0n;

  console.log(`  tx         ${receipt.receipt.transactionHash}`);
  console.log(`  success    ${receipt.success}   took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  USDC       ${formatUnits(usdc0, 6)} -> ${formatUnits(usdc1, 6)}`);
  console.log(`  ETH        ${formatUnits(eth0, 18)} -> ${formatUnits(eth1, 18)}`);
  console.log(`  moved      ${formatUnits(moved, 6)} USDC on purpose`);
  console.log(`  gas        ${formatUnits(gas, 6)} USDC, taken by the paymaster`);
  console.log(`  delegation ${code1 && code1 !== "0x" ? `active (${(code1.length - 2) / 2} bytes of code)` : "still unset"}`);

  if (receipt.success && eth1 === 0n && gas > 0n) {
    console.log("\nPASS. The settlement batch ran atomically from an account holding no ETH,");
    console.log("at an address identical to the settlement EOA's, with gas paid in USDC.");
    console.log("Every grant pinning that address keeps working — nothing has to expire.");
  } else if (receipt.success) {
    console.log("\nRan, but read the numbers above before calling it a pass.");
  } else {
    console.log("\nFAIL. Read the receipt before building on this.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
