// Be our own bundler: submit UserOperations with EntryPoint.handleOps directly.
//
//   pnpm tsx scripts/probe-self-bundler.ts
//   pnpm tsx scripts/probe-self-bundler.ts --ops 3
//
// THE QUESTION
//
// An MSCA cannot be driven by an ordinary transaction — its validation plugin
// answers NotImplemented(bytes4,uint8) to a runtime call of execute(), so it is
// reachable only through the EntryPoint. That is usually read as "you need a
// bundler", and then as "you need Pimlico".
//
// But handleOps(ops[], beneficiary) is permissionless: anyone may submit, and
// the beneficiary is paid out of the sender account's EntryPoint deposit. So
// this platform can be its own bundler, which would mean:
//
//   · no third-party bundler, no Gas Station, no Circle account
//   · one hop to the mempool instead of waiting in a shared queue
//   · N operations in ONE transaction, because handleOps takes an array
//
// This measures whether that is true, and what it costs, against the baseline
// of the same work done as ordinary separate transactions.
//
// WHAT IT STANDS IN FOR
//
// The real target is the renewal and external delegate keys, which would become
// MSCAs so their addresses can be rotated while grants keep pinning them. This
// cannot use them: every live grant names the delegate EOA inside the
// delegation struct, and a grant naming an MSCA delegate needs a subscriber's
// wallet signature that no script can produce.
//
// So it uses the SETTLEMENT MSCA doing harmless USDC transfers. The mechanics
// under test — can we submit, do several ops batch, how fast, how much gas —
// are identical whatever the calls happen to be.

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { toPackedUserOperation } from "viem/account-abstraction";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";
import { getSettlementAccount } from "../src/lib/chain/signers";
import { getSourceChain } from "../src/lib/gateway/chains";

const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

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

const ERC20_ABI = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const MSCA_EXECUTE_ABI = [
  { name: "execute", type: "function", stateMutability: "payable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [{ type: "bytes" }] },
] as const;

/**
 * Gas limits, set by hand.
 *
 * There is no bundler to estimate them, which is one of the real costs of this
 * approach — these have to be chosen, and the EntryPoint demands the account's
 * deposit covers their SUM times maxFeePerGas before it will run anything.
 * Generous on purpose: unused gas is refunded to the deposit, while too little
 * reverts the batch.
 */
const CALL_GAS = 150_000n;
const VERIFICATION_GAS = 300_000n;
const PRE_VERIFICATION_GAS = 60_000n;

/** 16 bytes each, high then low — the packed v0.7 layout. */
function packTwo(high: bigint, low: bigint): Hex {
  return `0x${high.toString(16).padStart(32, "0")}${low.toString(16).padStart(32, "0")}` as Hex;
}

async function main(): Promise<void> {
  const nOps = process.argv.includes("--ops")
    ? Number(process.argv[process.argv.indexOf("--ops") + 1])
    : 2;

  const source = getSourceChain("base");
  const rpc = process.env.PROBE_RPC_URL ?? "https://base-sepolia.gateway.tenderly.co";
  const chain = defineChain({
    id: source.chain.id,
    name: "Base Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });

  const owner = getSettlementAccount();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account = await toCircleSmartAccount({ client: publicClient as any, owner: owner as any });
  const msca = account.address as Address;
  const submitter = createWalletClient({ account: owner, chain, transport: http(rpc) });

  console.log(`Base Sepolia — self-bundled handleOps`);
  console.log(`  MSCA (sender)   ${msca}`);
  console.log(`  submitter       ${owner.address}   (pays gas, is reimbursed)`);
  console.log(`  ops in batch    ${nOps}`);

  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;

  /**
   * The deposit is the account's, not the submitter's.
   *
   * handleOps pays the beneficiary out of the SENDER's EntryPoint deposit, so
   * the MSCA must be funded before it can be submitted for — which is the
   * second ETH balance this approach needs. The submitter only fronts the gas
   * and gets it back.
   */
  const needed = (CALL_GAS + VERIFICATION_GAS + PRE_VERIFICATION_GAS) * maxFeePerGas * BigInt(nOps);
  let deposit = await publicClient.readContract({ address: ENTRY_POINT, abi: ENTRY_POINT_ABI, functionName: "balanceOf", args: [msca] });
  console.log(`  MSCA deposit    ${formatEther(deposit)} ETH  (needs ~${formatEther(needed)})`);

  if (deposit < needed) {
    const top = needed * 4n > parseEther("0.0005") ? needed * 4n : parseEther("0.0005");
    console.log(`  topping the deposit up by ${formatEther(top)} ETH …`);
    const h = await submitter.sendTransaction({
      to: ENTRY_POINT,
      value: top,
      data: encodeFunctionData({ abi: ENTRY_POINT_ABI, functionName: "depositTo", args: [msca] }),
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    // Pinned to the receipt's block: an unpinned read here showed the
    // pre-top-up figure and made the deposit look untouched afterwards.
    const topReceipt = await publicClient.getTransactionReceipt({ hash: h });
    deposit = await publicClient.readContract({ address: ENTRY_POINT, abi: ENTRY_POINT_ABI, functionName: "balanceOf", args: [msca], blockNumber: topReceipt.blockNumber });
    console.log(`  MSCA deposit    ${formatEther(deposit)} ETH`);
  }

  // ─── baseline: the same number of ordinary transactions ────────────────────
  const tiny = parseUnits("0.000001", 6);
  const transferData = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [owner.address, tiny] });

  console.log(`\nBaseline — ${nOps} ordinary transactions from the EOA:`);
  let baselineGas = 0n;
  const b0 = Date.now();
  for (let i = 0; i < nOps; i++) {
    const h = await submitter.sendTransaction({ to: source.usdc, data: transferData });
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    baselineGas += r.gasUsed;
  }
  const baselineMs = Date.now() - b0;
  console.log(`  ${(baselineMs / 1000).toFixed(1)}s total, ${baselineGas} gas across ${nOps} transactions`);

  // ─── the thing under test: one handleOps carrying nOps UserOperations ──────
  //
  // Sequential nonces in key 0. handleOps validates every op before executing
  // any, and each validation increments the account's nonce, so N+0, N+1 … in
  // one batch is legal. Different 192-bit keys would also work and would be
  // the way to run genuinely concurrent batches.
  const startNonce = await publicClient.readContract({ address: ENTRY_POINT, abi: ENTRY_POINT_ABI, functionName: "getNonce", args: [msca, 0n] });

  const packed = [];
  for (let i = 0; i < nOps; i++) {
    const callData = encodeFunctionData({
      abi: MSCA_EXECUTE_ABI,
      functionName: "execute",
      args: [source.usdc, 0n, transferData],
    });
    const unpacked = {
      sender: msca,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = toPackedUserOperation({ ...unpacked, signature } as any);
    packed.push({
      sender: p.sender,
      nonce: p.nonce,
      initCode: p.initCode ?? "0x",
      callData: p.callData,
      accountGasLimits: packTwo(VERIFICATION_GAS, CALL_GAS),
      preVerificationGas: PRE_VERIFICATION_GAS,
      gasFees: packTwo(maxPriorityFeePerGas, maxFeePerGas),
      paymasterAndData: p.paymasterAndData ?? "0x",
      signature: p.signature,
    });
  }

  console.log(`\nSelf-bundled — one handleOps carrying ${nOps} UserOperations:`);
  const t0 = Date.now();
  try {
    const hash = await submitter.sendTransaction({
      to: ENTRY_POINT,
      data: encodeFunctionData({ abi: ENTRY_POINT_ABI, functionName: "handleOps", args: [packed, owner.address] }),
      gas: 2_000_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const ms = Date.now() - t0;
    console.log(`  tx     ${receipt.transactionHash}`);
    console.log(`  status ${receipt.status}`);
    console.log(`  ${(ms / 1000).toFixed(1)}s total, ${receipt.gasUsed} gas in ONE transaction`);

    console.log(`\n  latency   ${(baselineMs / 1000).toFixed(1)}s -> ${(ms / 1000).toFixed(1)}s`);
    console.log(`  gas       ${baselineGas} -> ${receipt.gasUsed}`);
    console.log(
      `  per op    ${baselineGas / BigInt(nOps)} -> ${receipt.gasUsed / BigInt(nOps)} gas`
    );
    /**
     * Diagnostic only, and deliberately unable to fail the run.
     *
     * The first version read this inside the same try as the submission, and a
     * pinned read that raced the node ("block not found") printed FAILED under
     * a batch whose status was success — reporting a working settlement as a
     * broken one, which is the worse of the two possible lies.
     */
    try {
      const after = await publicClient.readContract({
        address: ENTRY_POINT,
        abi: ENTRY_POINT_ABI,
        functionName: "balanceOf",
        args: [msca],
        blockNumber: receipt.blockNumber,
      });
      console.log(`  deposit   ${formatEther(deposit)} -> ${formatEther(after)} ETH (the submitter's reimbursement)`);
    } catch {
      console.log(`  deposit   (read raced the node — the batch is unaffected)`);
    }
  } catch (e) {
    const err = e as Error & { shortMessage?: string; details?: string };
    console.log(`  FAILED: ${err.shortMessage ?? err.message.split("\n")[0]}`);
    if (err.details) console.log(`  details: ${err.details}`);
    console.log("\n  A revert here is the answer, not an accident: it means self-bundling this");
    console.log("  account needs more than handleOps and a funded deposit.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
