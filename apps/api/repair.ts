import "dotenv/config";
import { writeFileSync } from "node:fs";
import { prisma } from "./src/lib/prisma";
import { ids } from "./src/lib/ids";

const APPLY = process.env.APPLY === "true";
const SNAPSHOT = process.env.SNAPSHOT_PATH!;

async function main() {
  // Rebuild the list from evidence rather than trusting a hard-coded set: for
  // every completed sweep, the email the payer actually submitted is the truth,
  // and the subscription it produced should carry it.
  const sweeps = await prisma.sweep.findMany({
    where: { status: "complete" },
    select: {
      subscriberEmail: true, customerId: true, createdAt: true,
      session: { select: { subscriptionId: true, merchantId: true, merchant: { select: { name: true } } } },
    },
  });

  const repairs: {
    subId: string; subDbId: string; merchantId: string; merchantName: string; status: string;
    fromEmail: string | null; toEmail: string; fromCustomerId: string | null;
  }[] = [];

  for (const s of sweeps) {
    const ref = s.session?.subscriptionId;
    if (!ref || !s.subscriberEmail || !s.session) continue;
    const sub = await prisma.subscription.findFirst({
      where: { OR: [{ id: ref }, { subscriptionId: ref }] },
      select: { id: true, subscriptionId: true, subscriberEmail: true, customerId: true, status: true },
    });
    if (!sub) continue;
    const paid = s.subscriberEmail.toLowerCase();
    if ((sub.subscriberEmail ?? "").toLowerCase() === paid) continue;
    repairs.push({
      subId: sub.subscriptionId, subDbId: sub.id, merchantId: s.session.merchantId,
      merchantName: s.session.merchant?.name ?? "?", status: sub.status,
      fromEmail: sub.subscriberEmail, toEmail: paid, fromCustomerId: sub.customerId,
    });
  }

  console.log(`${repairs.length} rows to repair\n`);
  writeFileSync(SNAPSHOT, JSON.stringify(repairs, null, 2));
  console.log(`snapshot (for rollback) → ${SNAPSHOT}\n`);

  for (const r of repairs) {
    // The customer the payer should be attached to, at THIS merchant. Customers
    // are per-merchant (@@unique([merchantId, email])), so this never reuses a
    // row across merchants.
    let customer = await prisma.customer.findUnique({
      where: { merchantId_email: { merchantId: r.merchantId, email: r.toEmail } },
      select: { id: true, customerId: true },
    });
    const willCreate = !customer;

    console.log(`${r.subId} [${r.status}] @ ${r.merchantName}`);
    console.log(`   email    ${r.fromEmail} → ${r.toEmail}`);
    console.log(`   customer ${r.fromCustomerId ?? "none"} → ${customer?.id ?? "(new customer row)"}`);

    if (!APPLY) { console.log("   (dry run)\n"); continue; }

    if (!customer) {
      customer = await prisma.customer.create({
        // No emailVerifiedAt: this repair infers the address from the sweep the
        // payer submitted, which is not the same as an OTP-proven email.
        data: { customerId: ids.customer(), merchantId: r.merchantId, email: r.toEmail },
        select: { id: true, customerId: true },
      });
      console.log(`   created customer ${customer.customerId}`);
    }
    await prisma.subscription.update({
      where: { id: r.subDbId },
      data: { subscriberEmail: r.toEmail, customerId: customer.id },
    });
    console.log(`   ${willCreate ? "attached to new" : "re-pointed to existing"} customer — done\n`);
  }
}
main().catch((e) => { console.error(String(e).split("\n")[0]); process.exit(1); }).finally(() => process.exit(0));
