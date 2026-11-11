/**
 * Can the bridge path come back?
 *
 * THIS CHECK USED TO ASSERT SOMETHING ELSE, and that is worth recording. While
 * the migration was staged path by path, the rule was that the two halves of
 * one path agree: a grant pins its payees at signature time and a redeem pays
 * whoever was pinned, so if one side read DIRECT_SETTLEMENT_ENABLED and the
 * other did not, every redemption of every grant made under that flag reverted
 * with AllowedCalldataEnforcer:invalid-calldata — after the payer had signed,
 * and only when the first charge ran. That is how the rail went down on
 * 2026-10-28: the grant pinned the MSCA and the charge asked for the EOA.
 *
 * The staging is over. Redeems are now unconditionally direct — there is no
 * bridge arm left to diverge into — so demanding that they read the flag
 * started failing for the right reason and the wrong invariant.
 *
 * What matters now is that the deleted path stays deleted. CCTP came out in
 * pieces: burn/attest/mint helpers, a resume cron, BridgeTransfer writes, an
 * Arc redeem loop, an ERC-3009 pull. Any one of them reintroduced puts money
 * back in platform hands between the payer and the creator, which is the whole
 * thing the migration removed — and it would arrive as a plausible-looking
 * import rather than as an obvious regression.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const FLAG = "directSettlementEnabled";

/**
 * Modules that settle money, and the imports that would mean bridging again.
 *
 * Checked by IMPORT rather than by mention, so a comment explaining why the
 * bridge is gone does not trip it — several of these files carry exactly that
 * comment deliberately.
 */
const SETTLES = [
  "billing/direct-charge.ts",
  "billing/delegated-renewal.ts",
  "billing/scheduler.ts",
  "lib/checkout/cctp-activate.ts",
  "lib/checkout/complete.ts",
  "lib/chain/delegation.ts",
];

/**
 * Gone for good: deleting these was the point of the last step.
 *
 * Matched on the module's FINAL PATH SEGMENT, closed by the quote, because an
 * import writes a relative path and not the one in this list. The first
 * version compared against "billing/bridge" while the real line reads
 * `from "./bridge"`, so it passed a deliberately reintroduced import — the
 * same mistake the old aware() check made by counting import lines. The
 * closing quote is what stops "cctp" matching "cctp-activate".
 */
const DELETED = [
  { module: "billing/bridge.ts", segment: "bridge" },
  { module: "lib/chain/settlement-userop.ts", segment: "settlement-userop" },
  { module: "lib/gateway/cctp.ts", segment: "cctp" },
];

/**
 * Does this file BRANCH on the flag?
 *
 * The name alone is not enough and the first version of this check was wrong
 * for exactly that reason: it counted the import line, so reverting the
 * branch to `if (false)` while leaving the import still read as converted and
 * the check passed on a half-migrated path. It now wants a CALL — and not one
 * inside a comment or an import.
 */
const aware = (rel: string): boolean => {
  const body = readFileSync(join(SRC, rel), "utf8");
  return body
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s{2,}\w+,?$/.test(l))
    .some((l) => new RegExp(`\\b${FLAG}\\s*\\(`).test(l));
};

function main(): void {
  const findings: string[] = [];

  for (const rel of SETTLES) {
    const body = readFileSync(join(SRC, rel), "utf8");
    const imports = body
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /^\s*\}\s*from\s*"/.test(l) || /from\s*"/.test(l));
    for (const dead of DELETED) {
      const hit = new RegExp(`from\\s*["'][^"']*\\b${dead.segment}["']`);
      if (imports.some((l) => hit.test(l))) {
        findings.push(
          `${rel} imports ${dead.segment} — the bridge path is back in a module that settles money.`
        );
      }
    }
  }

  // The modules themselves must still be absent.
  for (const dead of DELETED) {
    if (existsSync(join(SRC, dead.module))) {
      findings.push(`${dead.module} exists again — it was deleted with the CCTP path.`);
    }
  }

  if (findings.length > 0) {
    console.log(`\nFAIL. ${findings.length} finding(s):\n`);
    for (const f of findings) console.log(`  ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${SETTLES.length} settling module(s) checked · none import the deleted bridge path`);
  console.log("\nPASS. Nothing settles through a bridge.");
}

main();
