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
  location: { hostname: "sweep-console-probe", protocol: "https:" },
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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Base Sepolia. Hardcoded rather than read from config: a probe that could be
// pointed at mainnet by an environment variable is a probe that eventually is.
const CHAIN_ID = 84532;
const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TOKEN_MESSENGER: Address = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
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

  if (usdc < parseUnits("1", 6)) {
    console.log("Needs at least 1 USDC. Run with --fund for the address.");
    return;
  }
  if (eth > 0n) {
    console.log("WARNING: the account holds ETH, so a pass would not prove the paymaster");
    console.log("paid. Send the ETH away and run again.");
    return;
  }

  // Settlement's real batch: approve the messenger, burn toward Arc, and send
  // the platform fee on. Amounts are tiny; the shape is what is being tested.
  const burnAmount = parseUnits("0.50", 6);
  const feeAmount = parseUnits("0.01", 6);
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

  const bundler = createBundlerClient({ account: smartAccount, chain, transport, paymaster: true });

  console.log("Sending one UserOperation with all three calls, paymaster: true …");
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
  console.log(`  paid for gas       ${formatUnits(gasInUsdc, 6)} USDC   (includes the 10% surcharge)`);

  console.log();
  if (receipt.success && ethAfter === 0n) {
    console.log("PASS. Settlement's whole batch ran from an account with no ETH, paid for in");
    console.log("USDC out of the balance it was already holding. The mechanism works.");
    console.log();
    console.log("Still to decide, and the probe cannot: the fee arithmetic currently leaves");
    console.log("settlement at exactly zero, and a paymaster draw breaks that — see the");
    console.log("'exact rather than a balance sweep' note in cctp-activate.ts. And every");
    console.log("existing grant pins the old EOA as payee, so both run until those expire.");
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
