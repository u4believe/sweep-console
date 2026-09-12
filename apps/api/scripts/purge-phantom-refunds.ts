// Deletes the zero-value "refund" Payment rows that cancelling used to write.
//
// Until the contract was retired, cancelling returned the unsettled escrow in the
// same transaction and this row was the receipt for it. Contract-free, the amount
// was always 0, so every cancel minted a Payment recording a refund that never
// happened — noise in the merchant's payment list and in any integration that
// counts refunds.
//
// Only amount = 0 rows are touched. The 22 non-zero refunds are real money that
// real subscribers received from the contract, and they stay.
//
// Dry run by default; pass --write to delete. A --write run first dumps the full
// rows to ./phantom-refunds-backup.json, because a delete has no undo and these
// rows are the only place a contract-era cancel tx hash is recorded.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";

(async () => {
  const write = process.argv.includes("--write");

  const phantom = await prisma.payment.findMany({
    where: { type: "refund", amount: 0n },
    select: {
      id: true,
      paymentId: true,
      isTestMode: true,
      txHash: true,
      createdAt: true,
      subscription: { select: { subscriptionId: true, status: true } },
      merchant: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const live = phantom.filter((p) => !p.isTestMode);
  console.log(`zero-value refund rows: ${phantom.length} (${live.length} live-mode)`);
  for (const p of phantom) {
    console.log(
      `  ${p.createdAt.toISOString()} ${p.paymentId} ${p.merchant.name}` +
        ` · ${p.subscription?.subscriptionId ?? "no sub"} · tx ${p.txHash ?? "none"}` +
        (p.isTestMode ? "" : "  ← LIVE")
    );
  }

  // A non-zero refund is a real on-chain return; make sure the filter above did
  // not somehow reach one.
  const kept = await prisma.payment.count({ where: { type: "refund", amount: { gt: 0n } } });
  console.log(`\nreal refunds left untouched: ${kept}`);

  if (!phantom.length) return;
  if (!write) return void console.log("\ndry run; pass --write to delete");

  const full = await prisma.payment.findMany({ where: { id: { in: phantom.map((p) => p.id) } } });
  const backup = `phantom-refunds-backup-${Date.now()}.json`;
  writeFileSync(backup, JSON.stringify(full, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nbacked up ${full.length} row(s) to ${backup}`);

  const { count } = await prisma.payment.deleteMany({
    where: { id: { in: phantom.map((p) => p.id) } },
  });
  console.log(`\ndeleted ${count} phantom refund row(s)`);
})().finally(() => prisma.$disconnect());
