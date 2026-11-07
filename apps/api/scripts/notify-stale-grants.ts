/**
 * Ask every payer whose grant is now unredeemable to sign again.
 *
 *   ARC_NETWORK=mainnet pnpm tsx scripts/notify-stale-grants.ts          # dry run
 *   ARC_NETWORK=mainnet pnpm tsx scripts/notify-stale-grants.ts --send   # sends
 *
 * DRY RUN BY DEFAULT. The other default mails real subscribers about their
 * money, and a flag is a cheap price for not doing that by accident.
 *
 * Run check-stale-grants.ts first: it is the same list without the sending,
 * and it shows what this is about to do.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { delegateAddressForNewGrant } from "../src/lib/chain/delegate-msca";
import { isMainnet } from "../src/lib/gateway/chains";
import { notifyStaleGrantPayers } from "../src/lib/email/reauthorization";

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const live = isMainnet();

  const delegates: Record<string, string> = {};
  for (const mode of ["hosted", "external"] as const) {
    try {
      delegates[mode] = delegateAddressForNewGrant(mode).toLowerCase();
    } catch (e) {
      // Refusing beats emailing everyone because an address could not be
      // resolved — that is the whole list, for no reason.
      console.log(`Cannot resolve the ${mode} delegate: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`network  ${live ? "mainnet" : "testnet"}`);
  console.log(`delegate hosted=${delegates.hosted}  external=${delegates.external}`);
  console.log(send ? "mode     SENDING\n" : "mode     dry run (pass --send to actually email)\n");

  const r = await notifyStaleGrantPayers({ delegates, mainnet: live, dryRun: !send });

  console.log(`\n${send ? "emailed" : "would email"} ${r.sent} payer(s).`);
  if (r.unreachable > 0) {
    console.log(
      `${r.unreachable} stale grant(s) have no subscriber email — rail mandates, which carry a\n` +
        `wallet rather than a person. Those payers can only be reached by the creator.`
    );
  }
  for (const f of r.failed) console.log(`  FAILED ${f.to}: ${f.reason.slice(0, 70)}`);
  if (r.failed.length > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

main();
