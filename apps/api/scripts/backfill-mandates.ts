// Phase 02 backfill: give every existing RenewalDelegation a public id and a
// direct merchant link, so `mandateId` and `merchantId` can be tightened to
// required in a follow-up push.
//
//   pnpm tsx scripts/backfill-mandates.ts          # dry run — reports, writes nothing
//   pnpm tsx scripts/backfill-mandates.ts --write  # apply
//
// Re-runnable: it only touches rows where the column is still null, so a partial
// run followed by a full one is safe. `mode` needs no backfill — every row that
// exists predates the rail, and the column's default is already "hosted".

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { ids } from "../src/lib/ids";

async function main() {
  const write = process.argv.includes("--write");
  console.log(write ? "MODE: write\n" : "MODE: dry run (pass --write to apply)\n");

  const rows = await prisma.renewalDelegation.findMany({
    select: {
      id: true,
      mandateId: true,
      merchantId: true,
      mode: true,
      status: true,
      sessionId: true,
      subscriptionId: true,
      subscription: { select: { merchantId: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // A mandate granted at checkout is bound to the SESSION first — the Subscription
  // row does not exist yet when the subscriber signs. 22 of these never converted
  // (the session is still "open"), so the subscription route finds no merchant for
  // them. The session knows, and it is the same merchant either way: the grant was
  // made on that merchant's checkout page.
  //
  // Note sessionId holds the PUBLIC id ("cs_test_..."), not the internal cuid.
  const sessionIds = [...new Set(rows.map((r) => r.sessionId).filter(Boolean) as string[])];
  const sessions = await prisma.checkoutSession.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true, merchantId: true },
  });
  const merchantBySession = new Map(sessions.map((s) => [s.sessionId, s.merchantId]));

  const merchantFor = (r: (typeof rows)[number]): string | undefined =>
    r.subscription?.merchantId ?? (r.sessionId ? merchantBySession.get(r.sessionId) : undefined);

  const needsId = rows.filter((r) => !r.mandateId);
  const needsMerchant = rows.filter((r) => !r.merchantId && merchantFor(r));
  // Neither a subscription nor a resolvable session — nothing to inherit from.
  // This is why merchantId cannot be made required in the same push that adds it:
  // the column has to exist before we can know whether the set is empty.
  const orphans = rows.filter((r) => !r.merchantId && !merchantFor(r));

  console.log(`total rows          ${rows.length}`);
  console.log(`  by mode           ${summarise(rows.map((r) => r.mode))}`);
  console.log(`  by status         ${summarise(rows.map((r) => r.status))}`);
  console.log(`need mandateId      ${needsId.length}`);
  const viaSub = needsMerchant.filter((r) => r.subscription?.merchantId).length;
  console.log(`need merchantId     ${needsMerchant.length}  (${viaSub} via subscription, ${needsMerchant.length - viaSub} via session)`);
  console.log(`unresolvable        ${orphans.length}`);

  if (orphans.length) {
    console.log(`\n  these stay null — no subscription and no surviving session:`);
    for (const o of orphans.slice(0, 10)) console.log(`    ${o.id}  status=${o.status}`);
    if (orphans.length > 10) console.log(`    … and ${orphans.length - 10} more`);
  }

  if (!write) {
    console.log("\nnothing written.");
    return;
  }

  let idsWritten = 0;
  for (const r of needsId) {
    // One row at a time rather than a bulk update: every row needs a DIFFERENT
    // generated id, and the @unique on mandateId means a collision must surface
    // as a failure on that row, not silently poison a batch.
    await prisma.renewalDelegation.update({
      where: { id: r.id },
      data: { mandateId: ids.mandate() },
    });
    idsWritten++;
  }

  let merchantsWritten = 0;
  for (const r of needsMerchant) {
    await prisma.renewalDelegation.update({
      where: { id: r.id },
      data: { merchantId: merchantFor(r)! },
    });
    merchantsWritten++;
  }

  console.log(`\nwrote mandateId   ${idsWritten}`);
  console.log(`wrote merchantId  ${merchantsWritten}`);

  const [noId, noMerchant] = await Promise.all([
    prisma.renewalDelegation.count({ where: { mandateId: null } }),
    prisma.renewalDelegation.count({ where: { merchantId: null } }),
  ]);
  console.log(`\nstill without mandateId:  ${noId}  ${noId === 0 ? "— safe to tighten to required" : "— re-run before tightening"}`);
  console.log(`still without merchantId: ${noMerchant}  ${noMerchant === 0 ? "— safe to tighten to required" : "— re-run before tightening"}`);
}

function summarise(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k}=${n}`).join(" ");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
