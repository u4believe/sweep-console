// Read-only diagnostic: list recent subscriptions (optionally filtered by email).
//   pnpm tsx scripts/find-subscriptions.ts                 # 15 most recent
//   pnpm tsx scripts/find-subscriptions.ts you@example.com # match an email
//
// Uses apps/api/.env — the SAME DATABASE_URL the running API writes to, so this
// reflects exactly what the /manage portal would query.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();

  const subs = await prisma.subscription.findMany({
    where: email
      ? { OR: [{ subscriberEmail: email }, { customer: { is: { email } } }] }
      : undefined,
    include: { merchant: { select: { name: true } }, plan: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 15,
  });

  console.log(email ? `\nSubscriptions matching "${email}":` : "\n15 most recent subscriptions:");
  if (subs.length === 0) {
    console.log("  (none found)");
  }
  for (const s of subs) {
    console.log(
      [
        `status=${s.status}`,
        `subscriberEmail=${s.subscriberEmail ?? "<null>"}`,
        `customerId=${s.customerId ?? "<null>"}`,
        `merchant=${s.merchant.name}`,
        `plan=${s.plan.name}`,
        `test=${s.isTestMode}`,
        `wallet=${s.walletAddress}`,
        `created=${s.createdAt.toISOString()}`,
        `id=${s.subscriptionId}`,
      ].join("  ")
    );
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
