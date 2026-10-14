// What would change if the paymaster path were switched on today?
//
// Read-only. It decides nothing and writes nothing — it runs the real routing
// logic over the real grants and prints where each one would settle, so the
// answer to "can Base and Arbitrum go gasless" is a count rather than a guess.
//
//   pnpm tsx scripts/check-settlement-targets.ts
//
// The thing worth looking at in the output is the ETH column. A grant that
// pins the settlement EOA keeps needing native gas on its chain no matter what
// the configuration says, because AllowedCalldataEnforcer will revert a
// redemption that goes anywhere else. Those grants are only retired by expiry.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { chainKeyForId } from "../src/lib/gateway/chains";
import { getSettlementAddress } from "../src/lib/chain/signers";
import { chainSettlesViaMsca, grantPins, settlementTargetFor } from "../src/lib/chain/settlement-target";
import type { Hex } from "viem";

async function main(): Promise<void> {
  const eoa = getSettlementAddress();
  const smart = process.env.SETTLEMENT_MSCA_ADDRESS;
  const enabled = process.env.SETTLEMENT_MSCA_ENABLED === "true";

  console.log(`settlement EOA            ${eoa}`);
  console.log(`SETTLEMENT_MSCA_ADDRESS   ${smart ?? "(unset)"}`);
  console.log(`MSCA flag                 ${enabled ? "on" : "off"}`);
  console.log();

  const grants = await prisma.renewalDelegation.findMany({
    where: { status: "active" },
    select: { grantId: true, chainId: true, context: true, expiry: true },
    orderBy: [{ chainId: "asc" }, { expiry: "asc" }],
  });

  if (grants.length === 0) {
    console.log("No active grants.");
    return;
  }

  type Row = { total: number; pinned: number; gasless: number; lastExpiry: Date | null };
  const byChain = new Map<number, Row>();

  for (const g of grants) {
    const row = byChain.get(g.chainId) ?? { total: 0, pinned: 0, gasless: 0, lastExpiry: null };
    row.total++;
    if (grantPins(g.context as Hex, eoa)) row.pinned++;
    // Asked with the flag forced on, so the report describes the decision
    // rather than the current setting — otherwise a run with the flag off
    // prints all zeros and answers nothing.
    const wouldBeGasless =
      chainSettlesViaMscaIfEnabled(g.chainId) && !grantPins(g.context as Hex, eoa);
    if (wouldBeGasless) row.gasless++;
    if (!row.lastExpiry || g.expiry > row.lastExpiry) row.lastExpiry = g.expiry;
    byChain.set(g.chainId, row);
  }

  console.log("chain          grants  pin the EOA  could use the MSCA  stuck on the EOA until");
  for (const [chainId, r] of [...byChain].sort((a, b) => a[0] - b[0])) {
    const key = chainKeyForId(chainId) ?? String(chainId);
    const needsEth = r.total - r.gasless;
    const until = needsEth > 0 && r.lastExpiry ? r.lastExpiry.toISOString().slice(0, 10) : "—";
    console.log(
      `${key.padEnd(12)} ${String(r.total).padStart(6)}  ${String(r.pinned).padStart(11)}  ${String(r.gasless).padStart(16)}  ${until}`
    );
  }

  const totals = [...byChain.values()].reduce(
    (a, r) => ({ total: a.total + r.total, gasless: a.gasless + r.gasless }),
    { total: 0, gasless: 0 }
  );
  console.log();
  console.log(`${totals.gasless} of ${totals.total} active grants could settle through the MSCA today.`);
  console.log(`${totals.total - totals.gasless} could not, and no configuration changes that.`);

  // Sanity: the live routing must agree with the hypothetical above wherever
  // the flag is actually on. If it does not, the policy and the report have
  // drifted and the report is the one lying.
  if (enabled && smart) {
    let disagreements = 0;
    for (const g of grants) {
      const live = settlementTargetFor(g.chainId, g.context as Hex);
      const expected = chainSettlesViaMscaIfEnabled(g.chainId) && !grantPins(g.context as Hex, eoa);
      if (live.viaMsca !== expected) disagreements++;
    }
    console.log(
      disagreements === 0
        ? "\nLive routing agrees with this report."
        : `\nWARNING: live routing disagrees on ${disagreements} grants.`
    );
  }
}

/**
 * The chain policy, asked as though the flag were on.
 *
 * chainSettlesViaMsca() folds the flag and the configured address into its
 * answer, which is right for routing and wrong for a report whose job is to
 * say what WOULD happen. This asks only the part that configuration cannot
 * change: whether Circle Paymaster is deployed on that chain.
 */
function chainSettlesViaMscaIfEnabled(chainId: number): boolean {
  const key = chainKeyForId(chainId);
  // All three settle through the MSCA now. Whether gas comes from USDC or ETH
  // differs by chain, but the ADDRESS does not, and the address is what
  // decides whether a grant can be redeemed into it.
  if (key === "base" || key === "arbitrum" || key === "optimism") return true;
  // Anything else (Arc, or a chain added later) is not a settlement source.
  return chainSettlesViaMsca(chainId);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
