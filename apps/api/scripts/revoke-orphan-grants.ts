// Revoke hosted grants that belong to no subscription and never will.
//
//   pnpm tsx scripts/revoke-orphan-grants.ts          # dry run (no writes)
//   pnpm tsx scripts/revoke-orphan-grants.ts --apply  # mark them revoked
//
// A grant is bound to its checkout SESSION when signed and only linked to a
// subscription when that checkout completes. A checkout that is abandoned, or
// refused at activation — the same-tier guard turns one away after the grant is
// already signed — leaves the row behind with no subscription, status "active"
// and the delegation live in the subscriber's wallet for its full year.
//
// Nothing charges them: every charge path filters on a subscription. But they
// are not harmless either. The portal lists grants per subscription, so one
// belonging to none is invisible there — the subscriber cannot see it and has no
// way to turn it off short of acting in their own wallet. reconcileMandates
// re-reads each one from its chain every night until it expires. And "cannot be
// charged" rests on a WHERE clause, not on anything the database or the chain
// enforces.
//
// Marking them revoked says what is already true. It is the same one-way
// transition the reconciler and the portal make, and nothing reads a revoked row
// back into use.
//
// ONLY expired sessions. A grant whose session could still complete is a
// checkout in progress, and revoking it would break the payment the subscriber
// is in the middle of making.
//
// This does NOT touch the chain. disableDelegation is onlyDeleGator: the signed
// permission stays in the wallet either way, and only its owner can remove it.
// Uses apps/api/.env — the same DATABASE_URL the running API writes to.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const now = new Date();

  const orphans = await prisma.renewalDelegation.findMany({
    where: {
      status: "active",
      subscriptionId: null,
      // Rail mandates carry no subscription by design and dedupe by mandateId.
      mode: "hosted",
    },
    select: {
      id: true, grantId: true, chainId: true, walletAddress: true,
      periodAmount: true, expiry: true, createdAt: true, sessionId: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (orphans.length === 0) {
    console.log("No orphaned hosted grants.");
    return;
  }

  // A session row may be gone entirely; absent is as settled as expired.
  const sessionIds = orphans.map((o) => o.sessionId).filter((s): s is string => !!s);
  const sessions = await prisma.checkoutSession.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true, status: true, expiresAt: true },
  });
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));

  const settled: typeof orphans = [];
  const inFlight: typeof orphans = [];
  for (const o of orphans) {
    const s = o.sessionId ? byId.get(o.sessionId) : undefined;
    const done = !s || s.status !== "open" || s.expiresAt < now;
    (done ? settled : inFlight).push(o);
  }

  console.log(`${orphans.length} orphaned hosted grant(s): ${settled.length} settled, ${inFlight.length} still in flight\n`);
  for (const o of settled) {
    console.log(
      `  chain ${String(o.chainId).padEnd(9)} ${o.walletAddress.slice(0, 12)}… ` +
        `cap ${(Number(o.periodAmount) / 1e6).toFixed(2).padStart(7)}  ` +
        `granted ${o.createdAt.toISOString().slice(0, 10)}  expires ${o.expiry.toISOString().slice(0, 10)}  ${o.grantId ?? o.id}`
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

  const { count } = await prisma.renewalDelegation.updateMany({
    where: { id: { in: settled.map((o) => o.id) } },
    data: { status: "revoked" },
  });
  console.log(`\nRevoked ${count}.`);
  console.log(
    "The delegations remain live in each wallet — only their owner can remove them there."
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
