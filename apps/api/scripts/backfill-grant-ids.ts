// Phase 03 backfill: give every RenewalDelegation its own public id under the
// name these rows actually have — a grant, one chain's redeemable authority —
// so `mandateId` can be freed up for the FK to Mandate.
//
//   pnpm tsx scripts/backfill-grant-ids.ts          # dry run — reports, writes nothing
//   pnpm tsx scripts/backfill-grant-ids.ts --write  # apply
//
// The suffix is REUSED, not regenerated: mdt_a1b2c3 becomes grt_a1b2c3. Every log
// line, support ticket and screenshot that names one of the old ids still leads to
// the right row after the rename, which a fresh random id would break.
//
// Re-runnable: only touches rows where grantId is still null.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { ids } from "../src/lib/ids";

/// The Supabase pooler refuses a connection now and then.
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
      select: { id: true, mandateId: true, grantId: true },
      orderBy: { createdAt: "asc" },
    })
  );

  const todo = rows.filter((r) => !r.grantId);
  console.log(`rows              ${rows.length}`);
  console.log(`already have one  ${rows.length - todo.length}`);
  console.log(`to write          ${todo.length}\n`);
  if (todo.length === 0) return;

  let written = 0;
  let regenerated = 0;
  for (const r of todo) {
    // Keep the suffix when the legacy id has the shape we minted it with; fall
    // back to a fresh id rather than producing something malformed.
    const suffix = /^mdt_[0-9a-f]{20}$/.test(r.mandateId) ? r.mandateId.slice(4) : null;
    const grantId = suffix ? `grt_${suffix}` : ids.grant();
    if (!suffix) regenerated++;
    if (write) {
      await retry(() => prisma.renewalDelegation.update({ where: { id: r.id }, data: { grantId } }));
      written++;
    } else if (written < 3) {
      console.log(`  ${r.mandateId} -> ${grantId}`);
      written++;
    }
  }

  if (!write) {
    console.log(`  … and ${todo.length - Math.min(todo.length, 3)} more`);
    return;
  }
  console.log(`wrote grantId     ${written}`);
  if (regenerated) console.log(`fresh ids minted  ${regenerated}  (legacy id was not in mdt_<20 hex> form)`);

  const left = await retry(() => prisma.renewalDelegation.count({ where: { grantId: null } }));
  console.log(
    `\nstill without a grantId: ${left}  ${left === 0 ? "— safe to tighten once every writer is deployed" : "— re-run"}`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
