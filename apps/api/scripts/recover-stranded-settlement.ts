// Bridge USDC that a failed payment left sitting in the settlement account.
//
//   ARC_NETWORK=mainnet pnpm tsx scripts/recover-stranded-settlement.ts --sweep swp_xxx
//   ARC_NETWORK=mainnet pnpm tsx scripts/recover-stranded-settlement.ts --sweep swp_xxx --apply
//
// Dry by default. Nothing moves without --apply.
//
// WHY THIS IS NEEDED
//
// When activation fails AFTER the pull, the subscriber's USDC is already in
// the settlement MSCA and nothing goes back for it. The sweep is marked
// "failed", no BridgeTransfer row is written on the hosted path — the burn
// goes through settleViaUserOp directly — and so no worker ever retries. The
// money sits in an account the platform controls with nothing recording that
// it is owed to a merchant.
//
// That happened on 2026-10-23: swp_a4436e70d1bbcc7f285a pulled 1.000000 USDC
// on Base, the burn hit a TokenMessenger with no code (the mainnet default was
// the testnet address), no CCTP message was emitted, and the payment died
// waiting for an attestation of nothing.
//
// WHAT IT RECOVERS, AND WHAT IT CANNOT
//
// Whatever is actually in settlement on that chain NOW — not the sweep's
// original price. Gas is already spent: that payment paid 0.055689 USDC to the
// paymaster, so 0.944311 of the 1.000000 survived. Recovering the full price
// would mean the platform topping up the difference, which is a decision for a
// person, not a script.
//
// It does not re-run the subscription side. If activation never created the
// subscription, this pays the merchant what was collected and leaves the
// subscriber without a subscription — deliberately, because minting money to a
// merchant and granting access are separate choices and the second one needs
// the operator to decide whether the subscriber is being charged again.

import "dotenv/config";
import { createPublicClient, formatUnits, getAddress, http, type Address, type Hex } from "viem";
import { prisma } from "../src/lib/prisma";
import { isMainnet, getSourceChain, chainKeyForId } from "../src/lib/gateway/chains";
import { getSettlementAddress } from "../src/lib/chain/signers";
import { settlementMscaAddress } from "../src/lib/chain/settlement-target";
import { settleViaUserOp } from "../src/lib/chain/settlement-userop";
import { treasuryAddress } from "../src/lib/chain/fee-payout";
import { getTokenMessenger, assertCctpContract } from "../src/lib/gateway/cctp";
import { ARC_DOMAIN } from "../src/lib/gateway/chains";
import { walletFor } from "../src/lib/merchant-wallet";
import { rpcUrlForChain } from "../src/lib/chain/delegation";

const BALANCE_OF = "0x70a08231";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function usdcBalance(chainId: number, token: Address, who: Address): Promise<bigint> {
  const source = getSourceChain(chainKeyForId(chainId)!);
  let rpc: string;
  try {
    rpc = rpcUrlForChain(chainId);
  } catch {
    rpc = source.chain.rpcUrls.default.http[0]!;
  }
  const client = createPublicClient({ chain: source.chain, transport: http(rpc) });
  const data = `${BALANCE_OF}${who.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
  const r = await client.call({ to: token, data });
  return r.data && r.data !== "0x" ? BigInt(r.data) : 0n;
}

async function main(): Promise<void> {
  const sweepId = arg("sweep");
  const apply = process.argv.includes("--apply");
  if (!sweepId) {
    console.log("Usage: --sweep swp_xxx [--apply]");
    process.exitCode = 1;
    return;
  }
  if (!isMainnet()) {
    console.log("ARC_NETWORK is not 'mainnet'. Re-run with ARC_NETWORK=mainnet.");
    process.exitCode = 1;
    return;
  }

  const sweep = await prisma.sweep.findFirst({ where: { sweepId } });
  if (!sweep) {
    console.log(`No sweep ${sweepId}.`);
    process.exitCode = 1;
    return;
  }

  // Sweep.sessionId is the FOREIGN KEY (an internal cuid), not the public
  // "cs_..." id — the same convention the schema warns about on Charge and
  // BridgeTransfer. Looking it up by sessionId finds nothing and reads as a
  // missing session rather than a wrong column.
  const session = await prisma.checkoutSession.findUnique({
    where: { id: sweep.sessionId },
    include: { merchant: true },
  });
  if (!session) {
    console.log(`Sweep ${sweepId} has no session ${sweep.sessionId}.`);
    process.exitCode = 1;
    return;
  }

  // The destination is decided the same way the live path decides it, so a
  // recovery cannot pay somewhere the real payment would not have.
  const payout = walletFor(session.merchant, session.isTestMode).address;
  if (!payout) {
    console.log(
      `Merchant ${session.merchant.merchantId} has no payout wallet for ` +
        `${session.isTestMode ? "test" : "live"} mode. Nothing to recover INTO — link one first.`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`sweep        ${sweep.sweepId}  status=${sweep.status}`);
  console.log(`             collected ${formatUnits(sweep.totalAmount, 6)} USDC from ${sweep.walletAddress}`);
  console.log(`             error: ${sweep.error ?? "-"}`);
  console.log(`merchant     ${session.merchant.merchantId}  mode=${session.isTestMode ? "test" : "LIVE"}`);
  console.log(`payout       ${payout}\n`);

  /**
   * The MSCA, not the owner EOA.
   *
   * getSettlementAddress() returns the KEY's address. The money is pulled into
   * the smart account that key owns, and those are different addresses — the
   * first version of this script read the EOA, found 0.000000 on every chain
   * and reported nothing to recover while 0.944311 sat in the MSCA.
   *
   * Both are checked below, because a grant that pinned the EOA settles there
   * instead and that money is just as stranded.
   */
  const msca = settlementMscaAddress();
  const eoa = getAddress(getSettlementAddress()) as Address;
  const holders: Array<[string, Address]> = msca
    ? [["MSCA", getAddress(msca) as Address], ["EOA", eoa]]
    : [["EOA", eoa]];

  // sourceChain can be null when activation failed before recording it, so
  // every mainnet chain is checked rather than trusting the column.
  const candidates = ["base", "arbitrum", "optimism"];
  const found: Array<{ key: string; chainId: number; token: Address; held: bigint; who: string; holder: Address }> = [];
  for (const key of candidates) {
    const source = getSourceChain(key);
    for (const [who, holder] of holders) {
      const held = await usdcBalance(source.chain.id, source.usdc as Address, holder).catch(() => -1n);
      console.log(
        `  ${key.padEnd(9)} ${who.padEnd(4)} ${holder}  ${held < 0n ? "(read failed)" : formatUnits(held, 6)} USDC`
      );
      if (held > 0n) found.push({ key, chainId: source.chain.id, token: source.usdc as Address, held, who, holder });
    }
  }
  console.log();

  if (found.length === 0) {
    console.log("Nothing in settlement on any mainnet chain. Nothing to recover.");
    return;
  }
  if (found.length > 1) {
    console.log(
      "Settlement holds USDC on more than one chain. This script will not guess which\n" +
        "belongs to this sweep — recover one chain at a time with --chain, or move the\n" +
        "others first."
    );
    const only = arg("chain");
    if (!only) {
      process.exitCode = 1;
      return;
    }
    found.splice(0, found.length, ...found.filter((f) => f.key === only));
    if (found.length === 0) {
      console.log(`No balance on --chain ${only}.`);
      process.exitCode = 1;
      return;
    }
  }

  const { key, chainId, held, who, holder } = found[0]!;
  const shortfall = sweep.totalAmount - held;

  console.log(`RECOVER on ${key}, from the settlement ${who} ${holder}`);
  console.log(`  recoverable   ${formatUnits(held, 6)} USDC  (what is there now)`);
  console.log(`  collected     ${formatUnits(sweep.totalAmount, 6)} USDC  (what the subscriber paid)`);
  if (shortfall > 0n) {
    console.log(
      `  gone to gas   ${formatUnits(shortfall, 6)} USDC — already spent on the failed attempt,\n` +
        `                so the merchant receives less than the price unless you top it up by hand`
    );
  }
  console.log(`  destination   ${payout} on Arc\n`);

  await assertCctpContract(
    createPublicClient({
      chain: getSourceChain(key).chain,
      transport: http((() => { try { return rpcUrlForChain(chainId); } catch { return getSourceChain(key).chain.rpcUrls.default.http[0]!; } })()),
    }),
    getTokenMessenger(key),
    "CCTP TokenMessenger",
    `CCTP_TOKEN_MESSENGER_${key.toUpperCase()}`
  );
  console.log(`  TokenMessenger ${getTokenMessenger(key)} — verified present\n`);

  if (!apply) {
    console.log("Dry run. Nothing moved. Re-run with --apply to burn and mint.");
    return;
  }

  const treasury = treasuryAddress();
  if (!treasury) {
    console.log("No treasury configured — settleViaUserOp needs one. Set PLATFORM_TREASURY_ADDRESS.");
    process.exitCode = 1;
    return;
  }

  // grossAmount === amount: the fee on the original payment was already taken
  // or already lost with it, and charging it twice would come out of the
  // merchant's recovery.
  const settled = await settleViaUserOp({
    chainId,
    token: getSourceChain(key).usdc as Hex,
    tokenMessenger: getTokenMessenger(key),
    amount: held,
    destinationDomain: ARC_DOMAIN,
    mintRecipient: payout as Hex,
    speed: "fast",
    grossAmount: held,
    treasury,
  });

  console.log(`  burn ${settled.burnTxHash}`);
  console.log(`  maxFee ${formatUnits(settled.maxFee, 6)}  gasPaid ${formatUnits(settled.gasPaid, 6)}`);
  console.log(
    `\nBurned. The mint follows the attestation — watch for it arriving at ${payout} on Arc.\n` +
      `This script does NOT mark the sweep settled: the subscriber still has no\n` +
      `subscription, and that is a separate decision.`
  );
}

void main().finally(() => prisma.$disconnect());
