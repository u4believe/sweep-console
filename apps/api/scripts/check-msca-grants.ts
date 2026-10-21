// Is anything still redeemable through a delegate MSCA?
//
//   ARC_NETWORK=mainnet pnpm tsx scripts/check-msca-grants.ts
//
// Read-only. Answers one question: can RENEWAL_DELEGATE_MSCA_ADDRESS and
// EXTERNAL_RELAYER_MSCA_ADDRESS be removed yet.
//
// They cannot be removed while any ACTIVE grant names one. ownerOfDelegateMsca
// matches on the address in those variables, not on DELEGATE_MSCA_ENABLED, so
// deleting them does not disable the MSCA path — it makes the pass stop
// RECOGNISING those grants. The renewal would then be attempted as a direct
// EOA call against a grant naming the MSCA, and DelegationManager rejects it
// because msg.sender is not the delegate. The subscription stops renewing and
// nothing says why.
//
// Re-granting a subscriber does not revoke their old grant. Revocation is
// explicit (the portal, the mandates route) or comes from the renewal pass
// rejecting one, so a re-granted subscriber can hold both for a while.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main(): Promise<void> {
  const addresses = [
    ["RENEWAL_DELEGATE_MSCA_ADDRESS", process.env.RENEWAL_DELEGATE_MSCA_ADDRESS],
    ["EXTERNAL_RELAYER_MSCA_ADDRESS", process.env.EXTERNAL_RELAYER_MSCA_ADDRESS],
  ] as const;

  const configured = addresses.filter(([, a]) => !!a);
  if (configured.length === 0) {
    console.log("Neither MSCA address is set. Nothing to check.");
    return;
  }

  let blocking = 0;

  for (const [name, addr] of configured) {
    const all = await prisma.renewalDelegation.findMany({
      where: { delegateAddress: { equals: addr!, mode: "insensitive" } },
      select: { grantId: true, chainId: true, status: true, mandateId: true, subscriptionId: true },
    });
    const active = all.filter((g) => g.status === "active");

    /**
     * Active is not the same as reachable.
     *
     * The renewal pass selects on `subscriptionId: { not: null }`, so a grant
     * with no subscription behind it is never chosen, whatever its status
     * says. Those are the leftovers of a checkout whose activation never
     * completed: the grant was signed, the payment failed, no subscription was
     * ever created.
     *
     * Counting them as blocking would keep a variable alive forever on the
     * strength of rows nothing can use — which is how dead configuration
     * outlives the thing it configured.
     */
    const reachable = active.filter((g) => g.subscriptionId !== null);
    const orphans = active.length - reachable.length;

    console.log(`${name}`);
    console.log(`  ${addr}`);
    console.log(
      `  ${all.length} grant(s) name it, ${active.length} active, ` +
        `${reachable.length} redeemable${orphans ? ` (${orphans} orphaned — no subscription)` : ""}\n`
    );

    for (const g of reachable) {
      console.log(`    REDEEMABLE  chain ${String(g.chainId).padEnd(6)} ${g.grantId ?? g.mandateId}`);
      blocking++;
    }
    if (reachable.length > 0) console.log();
  }

  if (blocking === 0) {
    console.log(
      "Safe to remove. No grant that the renewal pass can select names a delegate\n" +
        "MSCA, so nothing needs that address to be redeemed. Remove the variables\n" +
        "from both live services."
    );
    return;
  }

  console.log(
    `NOT safe to remove. ${blocking} redeemable grant(s) can only be collected through an MSCA.\n` +
      `Revoke or let them lapse first — or leave the variables set, which costs nothing\n` +
      `and lets both designs coexist until the last one is gone.`
  );
  process.exitCode = 1;
}

void main().finally(() => prisma.$disconnect());
