/**
 * Stop retrying a bridge that will never finish.
 *
 *   ARC_NETWORK=testnet pnpm tsx scripts/abandon-stuck-bridges.ts
 *   ARC_NETWORK=testnet pnpm tsx scripts/abandon-stuck-bridges.ts --apply
 *
 * Dry by default.
 *
 * WHY THIS IS THE LAST THING HOLDING THE SETTLEMENT PATH OPEN. Under direct
 * settlement nothing creates a BridgeTransfer any more, so advanceBridge only
 * ever sees rows written before the migration — and both renewal and charge
 * resume passes pick up anything still "pulled" or "burned". While such a row
 * exists, the CCTP machinery, the settlement account and its key all have to
 * stay, because the funds behind that row are real and owed.
 *
 * Marking one "abandoned" takes it out of both queries — neither matches
 * anything but "pulled" and "burned" — so the resume passes stop, and the
 * settlement path can be removed for that network.
 *
 * IT DOES NOT RECOVER THE MONEY. The USDC was burned on the source chain and
 * never minted at the destination; this only stops the retrying. So it
 * refuses on mainnet unless --force is passed: abandoning real money should
 * take more than a flag, and on testnet the amounts are worthless by
 * definition.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { chainKeyForIdAnyNetwork, isMainnetChainId, isMainnet } from "../src/lib/gateway/chains";

const usdc = (v: bigint) => (Number(v) / 1e6).toFixed(2);

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const live = isMainnet();

  const rows = (
    await prisma.bridgeTransfer.findMany({
      where: { status: { in: ["pulled", "burned"] } },
      select: {
        id: true, status: true, chainId: true, grossAmount: true,
        createdAt: true, burnTxHash: true, chargeId: true, subscriptionId: true,
      },
      orderBy: { createdAt: "asc" },
    })
  ).filter((r) => isMainnetChainId(r.chainId) === live);

  console.log(`network  ${live ? "mainnet" : "testnet"}`);
  console.log(`mode     ${apply ? "APPLYING" : "dry run (pass --apply to write)"}\n`);

  if (rows.length === 0) {
    console.log("No bridge is still pulled or burned on this network. Nothing to abandon.");
    console.log("The resume passes have nothing to pick up, so the settlement path can go.");
    return;
  }

  let total = 0n;
  for (const r of rows) {
    const age = Math.round((Date.now() - r.createdAt.getTime()) / 86_400_000);
    total += r.grossAmount;
    console.log(
      `  ${r.id}  ${r.status.padEnd(7)} ${(chainKeyForIdAnyNetwork(r.chainId) ?? r.chainId).toString().padEnd(10)} ` +
        `${usdc(r.grossAmount).padStart(8)} USDC  ${age}d  burn=${r.burnTxHash?.slice(0, 12) ?? "none"}…`
    );
  }
  console.log(`\n${rows.length} row(s), ${usdc(total)} USDC burned and never minted.`);

  if (live && !force) {
    console.log(
      "\nREFUSING on mainnet without --force. These amounts are real and were paid by someone;\n" +
        "abandoning them is a decision to write off, not a cleanup. Recover first if you can."
    );
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log("\nNothing written. Re-run with --apply to mark these abandoned.");
    return;
  }

  const { count } = await prisma.bridgeTransfer.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: "abandoned" },
  });
  console.log(`\nMarked ${count} row(s) abandoned. The resume passes query only "pulled" and`);
  console.log(`"burned", so neither will pick these up again.`);
  await prisma.$disconnect();
}

main();
