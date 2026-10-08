// Revoke hosted grants that belong to no subscription and never will.
//
//   pnpm tsx scripts/revoke-orphan-grants.ts          # dry run (no writes)
//   pnpm tsx scripts/revoke-orphan-grants.ts --apply  # mark them revoked
//
// The same sweep the nightly billing pass runs — this is the manual handle on
// it, for looking before it acts. Why orphans happen, why they matter and why a
// checkout still in progress is left alone: lib/subscriptions/orphan-grants.ts.
//
// Uses apps/api/.env — the same DATABASE_URL the running API writes to.
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  findSettledOrphanGrants,
  revokeOrphanGrantsOnce,
} from "../src/lib/subscriptions/orphan-grants";

const APPLY = process.argv.includes("--apply");

async function main() {
  const { settled, inFlight } = await findSettledOrphanGrants();

  if (settled.length === 0 && inFlight.length === 0) {
    console.log("No orphaned hosted grants.");
    return;
  }

  console.log(
    `${settled.length + inFlight.length} orphaned hosted grant(s): ` +
      `${settled.length} settled, ${inFlight.length} still in flight\n`
  );
  for (const o of settled) {
    console.log(
      `  chain ${String(o.chainId).padEnd(9)} ${o.walletAddress.slice(0, 12)}… ` +
        `cap ${(Number(o.periodAmount) / 1e6).toFixed(2).padStart(7)}  ` +
        `granted ${o.createdAt.toISOString().slice(0, 10)}  ` +
        `expires ${o.expiry.toISOString().slice(0, 10)}  ${o.grantId ?? o.id}`
    );
  }
  for (const o of inFlight) {
    console.log(`  SKIP (checkout in progress) ${o.grantId ?? o.id} on chain ${o.chainId}`);
  }

  if (settled.length === 0) return;
  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply to revoke ${settled.length}.`);
    return;
  }

  await revokeOrphanGrantsOnce();
  console.log("The delegations remain live in each wallet — only their owner can remove them there.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
