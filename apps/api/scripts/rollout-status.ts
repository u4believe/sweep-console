import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { isMainnet } from "../src/lib/gateway/chains";
import { directSettlementEnabled } from "../src/lib/chain/direct-settlement";
import { delegateMscaAddress, delegateMscaEnabled } from "../src/lib/chain/delegate-msca";
import { getRelayerAccount, settlementIsSeparate } from "../src/lib/chain/signers";

/**
 * Where the wallet-to-wallet migration actually stands, read from the
 * database and the environment rather than from memory.
 *
 * The plan lived in a conversation, not a file, so "what is left?" was
 * answered by recall and recall drifted. Two of its remaining items turned
 * out to be nothing: step 9 had no subscriber to re-authorize because every
 * subscription is cancelled, and the "stranded settlement dust" sits in the
 * address that is now the delegate, so it was never stranded.
 *
 * Read-only. Every line is a gate on deleting the CCTP path, which is the
 * last step and the only one that removes code.
 */
const prisma = new PrismaClient();

function row(label: string, state: "ok" | "blocked" | "note", detail: string) {
  const mark = state === "ok" ? "  ok    " : state === "blocked" ? "  BLOCK  " : "  note   ";
  console.log(`${mark}${label.padEnd(30)} ${detail}`);
}

async function main() {
  const live = isMainnet();
  console.log(`\nwallet-to-wallet rollout — ${live ? "MAINNET" : "testnet"}\n`);

  // 1. Settlement model in force.
  directSettlementEnabled()
    ? row("direct settlement", "ok", "on — payer settles to creator on the payer's chain")
    : row("direct settlement", "blocked", "OFF — DIRECT_SETTLEMENT_ENABLED is not true, so the bridge path is live");

  // 2. The delegate every new grant names. An EOA pins the KEY; the MSCA
  //    survives a rotation, which is the whole reason it exists.
  const msca = delegateMscaAddress("hosted");
  const owner = (() => {
    try {
      return getRelayerAccount("hosted").address;
    } catch {
      return null;
    }
  })();
  if (delegateMscaEnabled() && msca) {
    row("delegate in new grants", "ok", `${msca} (MSCA — key is rotatable)`);
  } else {
    row(
      "delegate in new grants",
      "blocked",
      `${owner ?? "?"} (OWNER EOA — rotating the key would orphan every grant). ` +
        `ENABLED=${process.env.DELEGATE_MSCA_ENABLED ?? "(unset)"} ADDR=${msca ?? "(unset)"}`
    );
  }

  // 3. The legacy settlement hop.
  settlementIsSeparate()
    ? row("legacy settlement hop", "blocked", "still a separate key — SETTLEMENT_PRIVATE_KEY is set")
    : row("legacy settlement hop", "ok", "retired — no separate settlement key");

  // 4. In-flight bridges. advanceBridge resumes "pulled" and "burned" rows and
  //    is deliberately NOT gated on the settlement flag, because a bridge
  //    begun before the migration still has to land. So these gate deletion.
  const pending = await prisma.bridgeTransfer.count({ where: { status: { in: ["pulled", "burned"] } } });
  pending === 0
    ? row("bridges in flight", "ok", "none — the resume passes have nothing to pick up")
    : row("bridges in flight", "blocked", `${pending} still pulled or burned — run abandon-stuck-bridges.ts`);

  // 5. Anyone still depending on the old path.
  const activeGrants = await prisma.renewalDelegation.count({ where: { status: "active" } });
  const activeSubs = await prisma.subscription.count({ where: { status: "active" } });
  activeSubs === 0
    ? row("subscribers to re-authorize", "ok", `none — every subscription is cancelled (${activeGrants} grant rows still active)`)
    : row("subscribers to re-authorize", "note", `${activeSubs} active subscription(s), ${activeGrants} active grant(s) — check-stale-grants.ts`);

  // 6. History that must survive the deletion.
  const minted = await prisma.bridgeTransfer.count({ where: { status: "minted" } });
  row("bridged history to keep", "note", `${minted} minted row(s) — receipts must still render after the CCTP code goes`);

  const blockers =
    (directSettlementEnabled() ? 0 : 1) + (settlementIsSeparate() ? 1 : 0) + (pending > 0 ? 1 : 0);
  console.log(
    blockers === 0
      ? "\nThe CCTP path can be deleted: nothing in flight and nothing live depends on it.\n"
      : `\n${blockers} gate(s) still block deleting the CCTP path.\n`
  );
}

main().finally(() => prisma.$disconnect());
