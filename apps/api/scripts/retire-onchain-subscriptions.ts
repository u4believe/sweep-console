// Retire the subscriptions that still bill through the SubscriptionManager.
//
//   pnpm tsx scripts/retire-onchain-subscriptions.ts          # dry run
//   pnpm tsx scripts/retire-onchain-subscriptions.ts --write  # cancel them
//
// Arc is settlement-only now: nothing is pulled from it, so renewFromAllowance
// has no future. A subscription carrying an onChainSubId can ONLY be charged by
// that call, so once the contract-side billing code is deleted these would be
// unchargeable — alive in the database, silently never renewing. Cancelling them
// first is the honest end: the subscriber stops being billed, the merchant is
// told, and the wallets can re-subscribe through the delegation path.
//
// It goes through revokeSubscription rather than writing statuses directly, so
// the full sequence happens: cancelSubscription() on-chain (which returns any
// settlement-window escrow in the same transaction), the status flip, every
// RenewalDelegation revoked, and the subscription.cancelled webhook.
//
// The on-chain cancel is best-effort on purpose. If it reverts, steps 2-3 still
// guarantee no future charge — and blocking a retirement on a transient chain
// failure would leave exactly the half-state this script exists to avoid.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { revokeSubscription } from "../src/lib/subscriptions/revoke";

/// The Supabase pooler drops a connection now and then.
async function retry<T>(f: () => Promise<T>, n = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= n) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function main() {
  const write = process.argv.includes("--write");
  console.log(write ? "MODE: write\n" : "MODE: dry run (pass --write to cancel)\n");

  const subs = await retry(() =>
    prisma.subscription.findMany({
      where: { status: { in: ["active", "trialing", "past_due"] }, onChainSubId: { not: null } },
      include: { plan: true, merchant: { select: { merchantId: true, name: true } } },
      orderBy: { createdAt: "asc" },
    })
  );

  console.log(`subscriptions still billing through the contract: ${subs.length}`);
  const liveMoney = subs.filter((s) => !s.isTestMode);
  const escrowed = subs.filter((s) => s.escrowBalance > 0n);
  // Both of these should be zero. If either is not, stop and look: cancelling a
  // live subscription is a billing decision, and escrow is someone's money.
  if (liveMoney.length > 0) {
    console.log(`\n!! ${liveMoney.length} are NOT test mode — refusing to touch them in bulk.`);
    for (const s of liveMoney) console.log(`   ${s.subscriptionId} ${s.merchant.name}`);
    return;
  }
  if (escrowed.length > 0) {
    console.log(`\n!! ${escrowed.length} still hold escrow. Cancelling returns it on-chain, but check first:`);
    for (const s of escrowed) console.log(`   ${s.subscriptionId} ${Number(s.escrowBalance) / 1e6} USDC`);
  }
  console.log();

  for (const sub of subs) {
    const label = `${sub.subscriptionId} (${sub.merchant.name} / ${sub.plan.name}, ${sub.subscriberEmail})`;
    if (!write) {
      console.log(`  would cancel ${label}`);
      continue;
    }
    try {
      const r = await revokeSubscription(sub, sub.merchant.merchantId, { reason: "arc_path_retired" });
      console.log(`  cancelled ${label}`);
      console.log(`      grants revoked ${r.revokedDelegations}`);
    } catch (e) {
      console.error(`  FAILED ${label}:`, e instanceof Error ? e.message : e);
    }
  }

  if (write) {
    const left = await retry(() =>
      prisma.subscription.count({
        where: { status: { in: ["active", "trialing", "past_due"] }, onChainSubId: { not: null } },
      })
    );
    console.log(
      `\nstill billing through the contract: ${left}  ${left === 0 ? "— safe to delete the contract-side billing code" : "— re-run"}`
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
