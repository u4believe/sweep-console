// Cancel subscriptions that were created against a PREVIOUS SubscriptionManager
// deployment (their stored `contractAddress` != the current
// SUBSCRIPTION_MANAGER_ADDRESS). Those subs don't exist on the current contract,
// so on-chain cancel/renew/settle all revert SubscriptionNotFound. This marks
// them cancelled in the DB ONLY — it does NOT touch any chain (the old contracts
// are divergent and the subs are unreachable from here anyway).
//
//   pnpm tsx scripts/cleanup-orphaned-subscriptions.ts          # dry run (no writes)
//   pnpm tsx scripts/cleanup-orphaned-subscriptions.ts --apply  # perform the cancellations
//
// Uses apps/api/.env — the same DATABASE_URL the running API writes to.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const ACTIVE = ["active", "trialing", "past_due", "paused"];

async function main() {
  const current = process.env.SUBSCRIPTION_MANAGER_ADDRESS?.toLowerCase();
  if (!current) {
    console.error("SUBSCRIPTION_MANAGER_ADDRESS is not set — cannot determine the current contract.");
    process.exit(1);
  }
  console.log(`Current contract: ${current}`);
  console.log(APPLY ? "Mode: APPLY (writing changes)\n" : "Mode: DRY RUN (no writes — pass --apply to commit)\n");

  // Orphaned = a non-cancelled sub that can't be acted on against the CURRENT
  // contract: either its contract differs from the current deployment, or it has
  // none recorded (predates contractAddress stamping). Both are unreachable
  // on-chain from here, so on-chain settle/renew/cancel revert SubscriptionNotFound.
  const candidates = await prisma.subscription.findMany({
    where: { status: { in: ACTIVE } },
    include: { merchant: { select: { name: true } }, plan: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const orphans = candidates.filter((s) => !s.contractAddress || s.contractAddress.toLowerCase() !== current);

  if (orphans.length === 0) {
    console.log("No orphaned subscriptions found. Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${orphans.length} orphaned subscription(s):`);
  for (const s of orphans) {
    console.log(
      `  ${s.subscriptionId}  status=${s.status}  email=${s.subscriberEmail ?? "<null>"}  ` +
        `merchant=${s.merchant.name}  plan=${s.plan.name}  contract=${s.contractAddress ?? "<none>"}`
    );
  }

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to cancel these and revoke their renewal grants.");
    await prisma.$disconnect();
    return;
  }

  let cancelled = 0;
  let revoked = 0;
  for (const s of orphans) {
    const [, delg] = await prisma.$transaction([
      prisma.subscription.update({
        where: { id: s.id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelReason: s.contractAddress ? "orphaned_contract_redeploy" : "orphaned_no_contract",
          escrowBalance: 0n,
          settlementDeadline: null,
        },
      }),
      prisma.renewalDelegation.updateMany({
        where: { subscriptionId: s.id, status: "active" },
        data: { status: "revoked" },
      }),
    ]);
    cancelled++;
    revoked += delg.count;
  }

  console.log(`\nDone. Cancelled ${cancelled} subscription(s); revoked ${revoked} renewal grant(s).`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
