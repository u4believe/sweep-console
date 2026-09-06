// Populate RenewalDelegation.salt and .delegationHash for rows granted before
// those columns existed, and report how far the database has drifted from the
// chain while we have the hashes in hand.
//
//   pnpm tsx scripts/backfill-delegation-identity.ts          # dry run
//   pnpm tsx scripts/backfill-delegation-identity.ts --write  # apply
//
// Re-runnable: only touches rows still missing a value. Expired mandates are
// skipped — nothing can redeem them, so their identity is not worth an RPC call.

import "dotenv/config";
import type { Address, Hex } from "viem";
import { prisma } from "../src/lib/prisma";
import { delegationIdentity, isDelegationDisabled } from "../src/lib/chain/delegation";

/// The Supabase transaction pooler refuses a connection now and then; a backfill
/// that dies two thirds through because of one blip is its own problem.
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
  console.log(write ? "MODE: write\n" : "MODE: dry run (pass --write to apply)\n");

  const rows = await retry(() =>
    prisma.renewalDelegation.findMany({
      where: { expiry: { gt: new Date() } },
      select: {
        id: true, mandateId: true, status: true, chainId: true,
        delegationManager: true, context: true, salt: true, delegationHash: true,
      },
      orderBy: { createdAt: "asc" },
    })
  );

  const todo = rows.filter((r) => !r.salt || !r.delegationHash);
  console.log(`unexpired mandates       ${rows.length}`);
  console.log(`missing salt or hash     ${todo.length}`);

  let wroteSalt = 0, wroteHash = 0, failed = 0;
  const hashes = new Map<string, string>();
  for (const r of rows) {
    if (r.delegationHash && r.salt) {
      hashes.set(r.id, r.delegationHash);
      continue;
    }
    const id = await delegationIdentity(r.chainId, r.delegationManager as Address, r.context as Hex);
    if (!id.salt && !id.delegationHash) { failed++; continue; }
    if (id.delegationHash) hashes.set(r.id, id.delegationHash);
    if (write) {
      await retry(() =>
        prisma.renewalDelegation.update({
          where: { id: r.id },
          data: {
            ...(r.salt ? {} : { salt: id.salt }),
            ...(r.delegationHash ? {} : { delegationHash: id.delegationHash }),
          },
        })
      );
    }
    if (!r.salt && id.salt) wroteSalt++;
    if (!r.delegationHash && id.delegationHash) wroteHash++;
  }

  console.log(`${write ? "wrote" : "would write"} salt              ${wroteSalt}`);
  console.log(`${write ? "wrote" : "would write"} delegationHash    ${wroteHash}`);
  if (failed) console.log(`undecodable contexts     ${failed}`);

  // Free once the hashes exist, and the whole reason the columns are here: the
  // subscriber can disable a delegation in their own wallet and nothing tells us.
  console.log(`\nchecking on-chain state of ${hashes.size} mandates…`);
  let disabled = 0, driftLive = 0, zombie = 0, unreadable = 0;
  for (const r of rows) {
    const hash = hashes.get(r.id);
    if (!hash) continue;
    let off: boolean;
    try {
      off = await isDelegationDisabled(r.chainId, r.delegationManager as Address, hash as Hex);
    } catch { unreadable++; continue; }
    if (off) disabled++;
    if (off && r.status === "active") { driftLive++; console.log(`  DRIFT  ${r.mandateId}  DB active, disabled on chain (chain ${r.chainId})`); }
    if (!off && r.status !== "active") zombie++;
  }
  console.log(`\ndisabled on chain                     ${disabled}`);
  console.log(`  …but DB still says "active"         ${driftLive}   <- renewals will fail at redeem`);
  console.log(`DB "revoked" but still live on chain  ${zombie}   <- our key can still redeem these`);
  if (unreadable) console.log(`could not read                        ${unreadable}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
