// Pause the retired SubscriptionManager on Arc.
//
//   pnpm --filter @sweep/api contract:retire                 # report state, change nothing
//   pnpm --filter @sweep/api contract:retire -- --pause      # send the pause() transaction
//
// The contract has no callers left in this codebase, but it is still deployed,
// still unpaused, and `subscribe()` is public — so anyone can still pull USDC
// into an escrow that no billing engine will ever settle. A contract cannot be
// deleted; pausing is the closest thing to retiring one.
//
// What pause() stops: subscribe, subscribeWithPermit, settlePeriod,
// renewFromAllowance. What it deliberately does NOT stop: cancelSubscription,
// which carries no whenNotPaused modifier and refunds escrow to the subscriber.
// So pausing first and refunding after is safe in that order, and only that
// order — pausing does not strand anyone's money.
//
// The owner key is read from the environment or a file you name. It is never
// taken as a command-line argument, because argv is visible to other processes
// and lands in your shell history.
//
//   CONTRACT_OWNER_KEY=0x… pnpm --filter @sweep/api contract:retire -- --pause
//   pnpm --filter @sweep/api contract:retire -- --pause --key-file ~/sweepconsole-retired/contracts.env.bak

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const SM = getAddress("0xf4fcf13de61054b7909d33e0a5b1e000c225c0af");
const USDC = getAddress(process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000");
const RPC = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network/";

const ABI = [
  { name: "paused", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "pause", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const args = process.argv.slice(2);
const doPause = args.includes("--pause");
const keyFileIdx = args.indexOf("--key-file");
const keyFile = keyFileIdx >= 0 ? args[keyFileIdx + 1] : undefined;

function ownerKey(): Hex | null {
  const fromEnv = process.env.CONTRACT_OWNER_KEY;
  if (fromEnv) return (fromEnv.startsWith("0x") ? fromEnv : `0x${fromEnv}`) as Hex;
  if (!keyFile) return null;
  // An .env-shaped file: pull PRIVATE_KEY= out of it without printing anything.
  const match = readFileSync(keyFile.replace(/^~/, process.env.HOME ?? "~"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^(CONTRACT_OWNER_KEY|PRIVATE_KEY)=/.test(l));
  if (!match) return null;
  const raw = match.split("=")[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return raw ? ((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex) : null;
}

async function main() {
  const pub = createPublicClient({ transport: http(RPC) });

  const [paused, owner, held] = await Promise.all([
    pub.readContract({ address: SM, abi: ABI, functionName: "paused" }),
    pub.readContract({ address: SM, abi: ABI, functionName: "owner" }),
    pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [SM] }),
  ]);

  console.log(`SubscriptionManager ${SM}`);
  console.log(`  paused:    ${paused}`);
  console.log(`  owner:     ${owner}`);
  console.log(`  USDC held: ${(Number(held) / 1e6).toFixed(6)}`);

  if (paused) {
    console.log("\nAlready paused. Nothing to do.");
    return;
  }

  const key = ownerKey();
  if (!key) {
    console.log(
      "\nNot paused. To pause it, re-run with --pause and supply the owner key via\n" +
        "  CONTRACT_OWNER_KEY=0x…   or   --key-file <path to an .env holding PRIVATE_KEY=>"
    );
    return;
  }

  const account = privateKeyToAccount(key);
  console.log(`\n  signer:    ${account.address}`);

  // Worth knowing before you decide the key is disposable: if this address also
  // signs renewals, retiring it is not free.
  for (const name of ["PLATFORM_PRIVATE_KEY", "RENEWAL_DELEGATE_PRIVATE_KEY", "EXTERNAL_RELAYER_PRIVATE_KEY"]) {
    const other = process.env[name];
    if (!other) continue;
    try {
      const a = privateKeyToAccount((other.startsWith("0x") ? other : `0x${other}`) as Hex).address;
      if (a === account.address) console.log(`  NOTE: this is the same key as ${name} — it is still in use.`);
    } catch { /* not a key */ }
  }

  if (account.address.toLowerCase() !== (owner as string).toLowerCase()) {
    console.error(`\nThat key is not the owner. pause() would revert.`);
    process.exit(1);
  }

  if (!doPause) {
    console.log("\nDry run. Re-run with --pause to send the transaction.");
    return;
  }

  const wallet = createWalletClient({ account, transport: http(RPC), chain: null });
  const hash = await wallet.writeContract({
    address: SM, abi: ABI, functionName: "pause", chain: null,
  });
  console.log(`\npause() sent: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`mined in block ${receipt.blockNumber}, status: ${receipt.status}`);

  const now = await pub.readContract({ address: SM, abi: ABI, functionName: "paused" });
  console.log(`paused is now: ${now}`);
  if (Number(held) > 0) {
    console.log(
      `\n${(Number(held) / 1e6).toFixed(6)} USDC is still escrowed. cancelSubscription still works while paused —\n` +
        `run scripts/retire-onchain-subscriptions.ts --write to return it to the subscribers it came from.`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
