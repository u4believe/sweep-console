// Revoke the grants that pin the settlement EOA as payee.
//
//   pnpm tsx scripts/revoke-eoa-pinned-grants.ts            # dry run
//   pnpm tsx scripts/revoke-eoa-pinned-grants.ts --apply
//
// Settlement moved to a Circle MSCA at a new address. A grant whose payee
// caveat names the old EOA can never be redeemed into the new account —
// AllowedCalldataEnforcer reverts anything else — so those grants would hold
// the old two-transaction path open indefinitely. On testnet the cheap answer
// is to stop honouring them.
//
// WHAT THIS DOES AND DOES NOT DO
//
// It is a Sweep-side revoke, which is the only kind available: disableDelegation
// on the DelegationManager is onlyDeleGator, so only the subscriber's own wallet
// can remove a signed permission. This marks the rows revoked so no pass will
// redeem them. The on-chain permission still exists and simply goes unused
// until it expires.
//
// Scoped to one grant row per chain, exactly as the portal's own grant-revoke
// is. A subscription with grants on three chains and a pin on one keeps the
// other two.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { getSettlementAddress } from "../src/lib/chain/signers";
import { grantPins } from "../src/lib/chain/settlement-target";
import { chainKeyForId } from "../src/lib/gateway/chains";
import type { Hex } from "viem";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const eoa = getSettlementAddress();
  console.log(`settlement EOA ${eoa}`);
  console.log(apply ? "MODE: apply\n" : "MODE: dry run (pass --apply to commit)\n");

  const grants = await prisma.renewalDelegation.findMany({
    where: { status: "active" },
    select: { id: true, grantId: true, mandateId: true, chainId: true, context: true, mode: true, expiry: true },
    orderBy: [{ chainId: "asc" }, { expiry: "asc" }],
  });

  const pinned = grants.filter((g) => grantPins(g.context as Hex, eoa));
  if (pinned.length === 0) {
    console.log("No active grants pin the settlement EOA. Nothing to do.");
    return;
  }

  for (const g of pinned) {
    console.log(
      `  ${(chainKeyForId(g.chainId) ?? g.chainId).toString().padEnd(10)} ${g.grantId ?? g.mandateId}  ` +
        `${g.mode.padEnd(8)} expires ${g.expiry.toISOString().slice(0, 10)}`
    );
  }
  console.log(`\n${pinned.length} of ${grants.length} active grants pin the EOA.`);

  if (!apply) {
    console.log("Dry run — nothing changed.");
    return;
  }

  const result = await prisma.renewalDelegation.updateMany({
    where: { id: { in: pinned.map((g) => g.id) }, status: "active" },
    data: { status: "revoked" },
  });
  console.log(`\nRevoked ${result.count} grant(s). The on-chain permissions remain until they expire;`);
  console.log("nothing will redeem them.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
