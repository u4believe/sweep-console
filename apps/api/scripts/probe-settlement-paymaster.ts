// Can settlement stop needing ETH?
//
// Settlement is the account that receives redeemed USDC on a source chain and
// then burns it toward Arc. It sends three kinds of transaction — approve,
// depositForBurn, and the fee transfer to treasury — and today each one costs
// it native gas on Base, Arbitrum and Optimism.
//
// It is the one relayer where paying gas in USDC is structurally natural: it
// holds USDC at the exact moment it transacts. This probe asks whether a Circle
// modular smart account can do settlement's whole job with a zero ETH balance,
// paying the Circle Paymaster out of the USDC it is already holding.
//
// It deliberately does NOT touch delegation. Settlement is not a delegate — it
// never calls redeemDelegations — so none of the contract-redeemer question
// applies here. That is what makes this the cheap one to try.
//
//   pnpm add -D @circle-fin/modular-wallets-core
//   pnpm tsx scripts/probe-settlement-paymaster.ts --fund     # step 1: address
//   pnpm tsx scripts/probe-settlement-paymaster.ts            # step 2: the run
//
// WHAT IT DOES NOT TOUCH
//
// No production key, no grant, no database write, no request path. It uses a
// throwaway owner key from PROBE_OWNER_KEY and a smart account that exists only
// for this test. Base Sepolia only — it refuses to run against a mainnet chain
// id, because the failure mode of a half-built burn is money in an account
// nobody is watching.
//
// WHAT A PASS MEANS
//
// That settlement's three calls batch into one UserOperation, that the
// paymaster covers them from the account's USDC, and that the account needed no
// ETH. It does not prove the integration: the payee pin in every existing grant
// still names the old EOA, so both would run until the last of those expires —
// 2027-10-11 on the current testnet grants.

import "dotenv/config";

/**
 * Circle's modular SDK does not run in Node without this.
 *
 * fetchFromApi — the function behind EVERY call it makes — begins:
 *
 *     const hostname = window?.location?.hostname || "unknown";
 *
 * Optional chaining does not protect an UNDECLARED identifier. `window?.x`
 * still throws ReferenceError when nothing named window exists, which in Node
 * is always, so the request never leaves the process. The line directly above
 * it guards properly with `typeof window !== "undefined"`, so this is an
 * oversight rather than a decision — the SDK is written for browsers and
 * nothing stops it working on a server except this.
 *
 * Declaring the global is enough: with it, the same call reaches Circle and
 * comes back "Invalid credentials" on a placeholder key, which is the API
 * answering rather than the process failing.
 *
 * Before relying on this in anything but a probe, see the note at the end of
 * this file — a shim that makes server code claim to be a browser is not free.
 */
(globalThis as { window?: unknown }).window ??= {
  location: {
    /**
     * This is not cosmetic. The SDK sends this hostname to Circle as
     *
     *     X-AppInfo: platform=web;version=1.0.16;uri=<hostname>
     *
     * and Circle enforces the client key's allowed-domain against it. Measured
     * on Base Sepolia with a real key: "www.sweepconsole.xyz" returns chainId
     * 0x14a34, while the bare apex, docs., localhost and an unrelated domain
     * all return 401 "Invalid credentials". The match is exact — no wildcard,
     * no apex fallback — so this must equal the domain in Circle Console.
     */
    hostname: process.env.CIRCLE_CLIENT_DOMAIN ?? "www.sweepconsole.xyz",
    protocol: "https:",
  },
};
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
  decodeEventLog,
  parseAbiItem,
  getContract,
  maxUint256,
  parseErc6492Signature,
  encodePacked,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Base Sepolia. Hardcoded rather than read from config: a probe that could be
// pointed at mainnet by an environment variable is a probe that eventually is.
const CHAIN_ID = 84532;
const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TOKEN_MESSENGER: Address = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
/**
 * Circle Paymaster — the contract that charges gas in USDC.
 *
 * NOT the same thing as `paymaster: true`. That asks the bundler's transport
 * for paymaster data, and Circle's transport answers with its own hosted
 * sponsorship (Gas Station): billed to the Circle account at 5%, settlement
 * stops if an invoice goes unpaid. Circle Paymaster has no API at all — it is
 * a bare contract, needs no Circle account, and takes its fee in USDC from the
 * sender at 10%, on Arbitrum and Base only.
 *
 * On the address: Circle's docs give 0x31BE08D3… for EntryPoint v0.7, while
 * viem's guide uses 0x3BA9A96e… in an ARBITRUM Sepolia example. Both are
 * deployed on Base Sepolia, but only the first holds an EntryPoint deposit
 * (1.0068 ETH vs 0). A paymaster with no deposit cannot pay for gas, so the
 * viem address would be rejected here. Checked on chain, not taken on trust.
 */
const CIRCLE_PAYMASTER_V07: Address = "0x31BE08D380A21fc740883c0BC434FcFc88740b58";

/// How much USDC the permit lets the paymaster take. A ceiling, not a charge.
const PERMIT_ALLOWANCE = parseUnits(process.env.PROBE_PERMIT ?? "1", 6);

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

/// EntryPoint v0.7. Carries the paymaster that ran and what gas really cost.
const USER_OP_EVENT = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"
);

const ARC_DOMAIN = 26;

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const TOKEN_MESSENGER_ABI = [
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

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. This probe uses throwaway credentials only — do not ` +
        `point it at a production key.`
    );
  }
  return v;
}

const chain = defineChain({
  id: CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.DELEGATION_RPC_84532 ?? "https://sepolia.base.org"] } },
});

async function main(): Promise<void> {
  const ownerKey = need("PROBE_OWNER_KEY") as Hex;
  const clientKey = need("CIRCLE_CLIENT_KEY");
  const clientUrl = process.env.CIRCLE_MODULAR_URL ?? "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";

  // Resolved at runtime, through a variable, so this file still typechecks in a
  // checkout that has not installed the SDK — nobody should have to take a
  // dependency to run `tsc` over a probe they are not running.
  const sdk = "@circle-fin/modular-wallets-core";
  let toCircleSmartAccount: any, toModularTransport: any;
  try {
    ({ toCircleSmartAccount, toModularTransport } = await import(/* @vite-ignore */ sdk));
  } catch {
    throw new Error(`${sdk} is not installed. Run: pnpm add -D ${sdk}`);
  }
  const { createBundlerClient } = (await import("viem/account-abstraction")) as any;

  const owner = privateKeyToAccount(ownerKey);
  const transport = toModularTransport(`${clientUrl}/baseSepolia`, clientKey);
  const publicClient = createPublicClient({ chain, transport });

  // The question the scope flagged: does toCircleSmartAccount accept a plain
  // privateKeyToAccount as owner, or only a wallet-derived local account? Both
  // are viem LocalAccounts, so it should — this is the line that proves it.
  let smartAccount: { address: Address };
  try {
    smartAccount = await toCircleSmartAccount({ client: publicClient, owner });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/invalid credentials/i.test(msg)) {
      throw new Error(
        "Circle rejected the client key. CIRCLE_CLIENT_KEY must be a CLIENT key from " +
          "Circle Console → Keys → Create a key → Client Key. It is not the same thing " +
          "as CIRCLE_API_KEY, which this repo already uses for user-controlled wallets."
      );
    }
    throw e;
  }
  const address = smartAccount.address as Address;

  const direct = createPublicClient({ chain, transport: http() });
  const [usdc, eth] = await Promise.all([
    direct.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
    direct.getBalance({ address }),
  ]);

  console.log(`owner (throwaway)  ${owner.address}`);
  console.log(`smart account      ${address}`);
  console.log(`  USDC   ${formatUnits(usdc, 6)}`);
  console.log(`  ETH    ${formatUnits(eth, 18)}   ← must stay 0 for the probe to mean anything`);
  console.log();

  if (process.argv.includes("--fund")) {
    console.log("Send ~2 USDC (and no ETH) to the smart account above, then run again.");
    return;
  }

  // Enough to move, plus headroom for the paymaster to take its cut.
  const required = parseUnits(process.env.PROBE_BURN ?? "0.50", 6) + parseUnits(process.env.PROBE_FEE ?? "0.01", 6) + parseUnits("0.05", 6);
  if (usdc < required) {
    console.log(`Needs at least ${formatUnits(required, 6)} USDC. Run with --fund for the address,`);
    console.log("or shrink the run with PROBE_BURN / PROBE_FEE.");
    return;
  }
  if (eth > 0n) {
    console.log("WARNING: the account holds ETH, so a pass would not prove the paymaster");
    console.log("paid. Send the ETH away and run again.");
    return;
  }

  // Settlement's real batch: approve the messenger, burn toward Arc, and send
  // the platform fee on. Amounts are tiny; the shape is what is being tested.
  /**
   * Sizes are adjustable because repeated runs drain the account and topping
   * up a testnet faucet is slower than turning a dial. Nothing here depends on
   * the amount — the batch either composes or it does not.
   */
  const burnAmount = parseUnits(process.env.PROBE_BURN ?? "0.50", 6);
  const feeAmount = parseUnits(process.env.PROBE_FEE ?? "0.01", 6);
  const treasury = (process.env.PLATFORM_TREASURY_ADDRESS ?? owner.address) as Address;
  const mintRecipient = `0x${"0".repeat(24)}${owner.address.slice(2)}` as Hex;

  const calls = [
    {
      to: USDC,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [TOKEN_MESSENGER, burnAmount] }),
    },
    {
      to: TOKEN_MESSENGER,
      data: encodeFunctionData({
        abi: TOKEN_MESSENGER_ABI,
        functionName: "depositForBurn",
        // maxFee 0 and threshold 2000 = Standard. Fast would add a CCTP fee
        // that has nothing to do with what is being measured here.
        args: [burnAmount, ARC_DOMAIN, mintRecipient, USDC, `0x${"0".repeat(64)}` as Hex, 0n, 2000],
      }),
    },
    {
      to: USDC,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [treasury, feeAmount] }),
    },
  ];

  /**
   * Circle Paymaster, built by hand.
   *
   * The sender signs an EIP-2612 permit letting the paymaster pull USDC, and
   * that signature IS the paymasterData. Two things about doing it from a
   * smart account rather than an EOA:
   *
   *   · USDC must accept the permit through ERC-1271, since the signer is a
   *     contract. That only works once the account is deployed — a first
   *     UserOperation cannot pay for its own deployment this way.
   *   · the account's signTypedData takes the SDK's raw-sign path, so the
   *     owner needs `sign`, not just `signMessage`. privateKeyToAccount has
   *     it; a KMS-backed viem account built with toAccount() would not, and
   *     this is exactly where that would break.
   */
  const circlePaymaster = {
    async getPaymasterData() {
      const token = getContract({ client: publicClient, address: USDC, abi: EIP2612_ABI });
      const [name, version, nonce] = await Promise.all([
        token.read.name(),
        token.read.version(),
        token.read.nonces([smartAccount.address]),
      ]);

      const wrapped = await (smartAccount as any).signTypedData({
        domain: { name, version, chainId: chain.id, verifyingContract: USDC },
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
          owner: smartAccount.address,
          spender: CIRCLE_PAYMASTER_V07,
          value: PERMIT_ALLOWANCE,
          nonce,
          deadline: maxUint256,
        },
      });
      // Undeployed accounts sign ERC-6492-wrapped; unwrap or the permit reverts.
      const { signature } = parseErc6492Signature(wrapped);

      return {
        paymaster: CIRCLE_PAYMASTER_V07,
        paymasterData: encodePacked(
          ["uint8", "address", "uint256", "bytes"],
          [0, USDC, PERMIT_ALLOWANCE, signature]
        ),
        paymasterVerificationGasLimit: 200_000n,
        /**
         * NOT the 15_000 that viem's guide uses. This paymaster rejects that
         * with PostOpGasLimitTooLow(uint256,uint256) — selector 0x5ff4afc1,
         * which surfaces only as a bare "AA33 reverted" through the bundler.
         * Measured by calling validatePaymasterUserOp directly as the
         * EntryPoint: 15_000 reverts, 40_000 passes. 65_000 leaves room.
         */
        paymasterPostOpGasLimit: 65_000n,
        isFinal: true,
      };
    },
  };

  /**
   * --gas-station reverts to Circle's hosted sponsorship, for comparison.
   * Default is Circle Paymaster, which is the one that charges USDC and so the
   * one whose cost this probe exists to measure.
   */
  const useGasStation = process.argv.includes("--gas-station");
  const bundler = createBundlerClient({
    account: smartAccount,
    chain,
    transport,
    paymaster: useGasStation ? true : circlePaymaster,
  });

  console.log(
    useGasStation
      ? "Sending one UserOperation, Gas Station sponsorship (paymaster: true) …"
      : `Sending one UserOperation, Circle Paymaster ${CIRCLE_PAYMASTER_V07} …`
  );
  const t0 = Date.now();
  let hash: Hex;
  try {
    hash = await bundler.sendUserOperation({ account: smartAccount, calls });
  } catch (e) {
    console.log("\nFAIL at send. This is the answer, not an accident:");
    console.log(`  ${(e as Error).message}`);
    console.log("\nIf it is an estimation error, settlement cannot batch this way and the");
    console.log("integration is not worth building. If it is a paymaster error, read whether");
    console.log("the account still owes an approval to the paymaster contract.");
    return;
  }

  console.log(`  userOp ${hash}`);
  const receipt = await bundler.waitForUserOperationReceipt({ hash });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const [usdcAfter, ethAfter] = await Promise.all([
    direct.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
    direct.getBalance({ address }),
  ]);

  console.log();
  console.log(`  tx       ${receipt.receipt.transactionHash}`);
  console.log(`  success  ${receipt.success}`);
  console.log(`  took     ${secs}s`);
  console.log();
  console.log(`  USDC  ${formatUnits(usdc, 6)} → ${formatUnits(usdcAfter, 6)}`);
  console.log(`  ETH   ${formatUnits(eth, 18)} → ${formatUnits(ethAfter, 18)}`);

  // What the paymaster actually charged, over and above the 0.51 that moved.
  const moved = burnAmount + feeAmount;
  const spent = usdc - usdcAfter;
  const gasInUsdc = spent > moved ? spent - moved : 0n;
  console.log();
  console.log(`  moved on purpose   ${formatUnits(moved, 6)} USDC`);
  console.log(`  paid for gas       ${formatUnits(gasInUsdc, 6)} USDC`);

  /**
   * Which paymaster product actually ran — the two differ in who pays and how
   * much, and the balances alone cannot tell them apart.
   *
   * Circle Paymaster pulls USDC from the sender via an EIP-2612 permit and adds
   * 10%. Gas Station sponsors from the Circle account and adds ~5%. If gas drew
   * no USDC, the second one ran, and a zero here means "sponsored" rather than
   * "free" — the bill exists, it is just not on chain.
   */
  const opEvent = receipt.logs
    .map((log: { data: Hex; topics: [] }) => {
      try {
        return decodeEventLog({ abi: [USER_OP_EVENT], data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    })
    .find((d: { eventName?: string } | null) => d?.eventName === "UserOperationEvent");

  if (opEvent) {
    const { paymaster, actualGasCost } = opEvent.args as { paymaster: Address; actualGasCost: bigint };
    console.log(`  paymaster          ${paymaster}`);
    console.log(`  gas cost on chain  ${formatUnits(actualGasCost, 18)} ETH, paid by the paymaster`);
    if (gasInUsdc === 0n && actualGasCost > 0n) {
      console.log();
      console.log("  NOTE: no USDC was taken for gas, so this was SPONSORED (Gas Station),");
      console.log("  not Circle Paymaster charging USDC. The 10% surcharge was never");
      console.log("  exercised here, and this run says nothing about what it costs.");
    }
  }

  console.log();
  if (receipt.success && ethAfter === 0n) {
    console.log("PASS. Settlement's approve + depositForBurn + fee transfer ran as ONE");
    console.log("atomic UserOperation from an account holding no ETH at all.");
    console.log();
    if (gasInUsdc > 0n) {
      console.log(`Gas was CHARGED IN USDC: ${formatUnits(gasInUsdc, 6)} drawn from the account's own`);
      console.log("balance, no Circle account and no invoice involved.");
      console.log();
      console.log("Two things this does NOT settle. Testnet gas is nothing like mainnet, so");
      console.log("the figure above predicts no cost. And a draw against this wallet is");
      console.log("exactly what the exact-amount fee arithmetic cannot absorb — settlement");
      console.log("is computed to land at zero, so the gas has to come from somewhere that");
      console.log("is not the swept balance.");
    } else {
      console.log("Gas was SPONSORED, not charged — see the note above. The cost question");
      console.log("is untouched by this run.");
    }
    console.log();
    console.log();
    console.log("Every existing grant pins the old settlement EOA as payee, so the two run");
    console.log("side by side until those expire. Nothing here shortens that.");
  } else {
    console.log("FAIL. Read the receipt above before building anything on this.");
  }
}

/**
 * On shipping the window shim.
 *
 * It is fine here: one process, one purpose, nothing else running. It is not
 * obviously fine in the API, where a global named `window` is how plenty of
 * libraries decide they are in a browser — and some of them then reach for
 * localStorage, or pick a bundle, or skip a Node-only code path. If this
 * becomes production code the shim wants to be scoped to the Circle calls
 * rather than set once at boot, and the better answer is to ask Circle to
 * guard that line as they already guard the one above it.
 */

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
