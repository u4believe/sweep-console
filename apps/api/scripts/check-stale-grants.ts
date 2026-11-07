/**
 * Which active grants can no longer be redeemed, and whose they are.
 *
 *   ARC_NETWORK=mainnet pnpm tsx scripts/check-stale-grants.ts
 *
 * Read-only.
 *
 * A GRANT NAMES ITS DELEGATE AT SIGNATURE TIME. Switching the delegate — EOA
 * to 7702, 7702 to MSCA — does not migrate anything: DelegationManager checks
 * msg.sender against the delegate in the signed context, so a grant naming
 * the old address is redeemable by nothing. There is no server-side fix. The
 * payer has to sign again.
 *
 * That is step 9 of the rollout, and this is the list it works from: who must
 * re-authorize, on which chains, for how much. Running it BEFORE the switch
 * says how much re-authorization the switch will cost; running it after says
 * how much is outstanding.
 *
 * It reports rather than acts. Nothing here emails anyone.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { delegateAddressForNewGrant } from "../src/lib/chain/delegate-msca";
import { chainKeyForIdAnyNetwork, isMainnetChainId, isMainnet } from "../src/lib/gateway/chains";
import { directSettlementEnabled, treasuryPayee } from "../src/lib/chain/direct-settlement";

const usdc = (v: bigint | null) => (v === null ? "—" : (Number(v) / 1e6).toFixed(2));

async function main(): Promise<void> {
  const live = isMainnet();
  let wanted: Record<string, string> = {};
  for (const mode of ["hosted", "external"] as const) {
    try {
      wanted[mode] = delegateAddressForNewGrant(mode).toLowerCase();
    } catch (e) {
      // Both delegate flags on is a refusal, not a value — say so rather than
      // reporting every grant stale against an address that cannot exist.
      console.log(`Cannot resolve the ${mode} delegate: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`network    ${live ? "mainnet" : "testnet"}`);
  console.log(`direct     ${directSettlementEnabled()}`);
  console.log(`delegate   hosted=${wanted.hosted}  external=${wanted.external}`);
  try {
    console.log(`treasury   ${treasuryPayee()}`);
  } catch {
    console.log(`treasury   NOT SET — every direct settlement would throw`);
  }
  console.log();

  /**
   * This deployment's grants only.
   *
   * Test and live are separate deployments over one database, so an
   * unfiltered read mixes them — and a mainnet operator reading a list that
   * includes sandbox payers would email people about a subscription that was
   * never real. The chain id is the honest discriminator here: a grant's own
   * chain says which network it belongs to, and it is on the row rather than
   * two joins away.
   */
  const grants = (await prisma.renewalDelegation.findMany({
    where: { status: "active" },
    select: {
      id: true, chainId: true, delegateAddress: true, mode: true,
      periodAmount: true, subscriptionId: true, mandateId: true,
      // A rail grant addresses its mandate through sessionId — mandateId is
      // this row's own legacy public id and resolves to nothing. See
      // mandateGrantsWhere in lib/rail.ts.
      sessionId: true,
      subscription: { select: { subscriptionId: true, subscriberEmail: true, isTestMode: true } },
    },
  })).filter((g) => isMainnetChainId(g.chainId) === live);

  if (grants.length === 0) {
    console.log("No active grants. Nothing to re-authorize.");
    return;
  }

  const stale = grants.filter(
    (g) => g.delegateAddress.toLowerCase() !== (wanted[g.mode] ?? wanted.hosted)
  );

  // Who, not how many: step 9 is a list of people to contact.
  const railIds = [
    ...new Set(stale.filter((g) => g.mode === "external").map((g) => g.sessionId).filter(Boolean)),
  ] as string[];
  const mandates = new Map(
    (
      await prisma.mandate.findMany({
        where: { mandateId: { in: railIds } },
        select: { mandateId: true, email: true, verifiedEmail: true },
      })
    ).map((m) => [m.mandateId, m])
  );

  const byPayer = new Map<string, { chains: string[]; amount: bigint }>();
  for (const g of stale) {
    const man = g.sessionId ? mandates.get(g.sessionId) : undefined;
    const who =
      man?.verifiedEmail ??
      man?.email ??
      g.subscription?.subscriberEmail ??
      `unreachable:${g.sessionId ?? g.mandateId}`;
    const row = byPayer.get(who) ?? { chains: [], amount: 0n };
    // One payer on two grants on one chain is one chain, not two — a rail
    // mandate and a hosted grant can both name it.
    const ck = chainKeyForIdAnyNetwork(g.chainId) ?? String(g.chainId);
    if (!row.chains.includes(ck)) row.chains.push(ck);
    row.amount = g.periodAmount ?? row.amount;
    byPayer.set(who, row);
  }

  console.log(`${grants.length} active grant(s); ${stale.length} name a delegate we no longer use.\n`);
  for (const [who, row] of byPayer) {
    console.log(`  ${who.padEnd(34)} ${usdc(row.amount).padStart(8)} USDC  [${row.chains.sort().join(", ")}]`);
  }

  if (stale.length === 0) {
    console.log("\nPASS. Every active grant names the current delegate.");
    return;
  }
  console.log(
    `\n${byPayer.size} payer(s) must re-authorize. Until they do, their renewals collect nothing —\n` +
      `not a payment failure, an authorization that no longer exists. Revoking the dead grants\n` +
      `first is cleaner than leaving them active and unredeemable.`
  );
  process.exitCode = 1;
}

main();
