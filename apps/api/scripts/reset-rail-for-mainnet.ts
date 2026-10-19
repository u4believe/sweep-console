// Clear rail grants that were only ever meant for testing.
//
//   pnpm tsx scripts/reset-rail-for-mainnet.ts            # report only
//   pnpm tsx scripts/reset-rail-for-mainnet.ts --apply    # write
//
// WHY THIS EXISTS
//
// Merchant.externalRailEnabled is ONE column and the database is shared
// between the two deployments, so a grant made to unblock a Sepolia
// experiment was silently a grant over real payers on mainnet.
//
// Testnet no longer consults the column at all (middleware/externalRail.ts),
// which means it now has exactly one meaning: LIVE rail access. Anything set
// while that was not its meaning should not be read as though it were.
//
// Clearing it costs a testnet developer nothing — the rail is open there — and
// it makes every live grant something an operator decided deliberately, after
// this change, for mainnet.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const granted = await prisma.merchant.findMany({
    where: { externalRailEnabled: true },
    select: {
      id: true,
      merchantId: true,
      email: true,
      railGrantedAt: true,
      railGrantedBy: true,
      _count: { select: { mandates: true, charges: true } },
    },
  });

  if (granted.length === 0) {
    console.log("No merchant holds externalRailEnabled. Nothing to clear.");
    return;
  }

  console.log(`${granted.length} merchant(s) hold the rail flag:\n`);
  for (const m of granted) {
    console.log(`  ${m.merchantId}  ${m.email}`);
    console.log(
      `    granted ${m.railGrantedAt?.toISOString() ?? "(unrecorded)"}` +
        `${m.railGrantedBy ? ` by ${m.railGrantedBy}` : ""}` +
        `  mandates=${m._count.mandates} charges=${m._count.charges}`
    );
  }

  if (!apply) {
    console.log(
      `\nReport only. Re-run with --apply to clear all ${granted.length}.\n` +
        `Testnet is unaffected either way — the rail is open there and the column is not read.\n` +
        `On mainnet each of these would otherwise be a standing entitlement over real payers.`
    );
    return;
  }

  // railRequestedAt is left alone on purpose: it records that someone asked,
  // which is still true and is what the operator queue sorts by if they ask
  // again for live.
  const { count } = await prisma.merchant.updateMany({
    where: { externalRailEnabled: true },
    data: { externalRailEnabled: false, railGrantedAt: null, railGrantedBy: null },
  });

  console.log(`\nCleared ${count}. Live rail access is now granted only by a deliberate decision.`);
}

void main().finally(() => prisma.$disconnect());
