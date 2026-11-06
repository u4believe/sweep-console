/**
 * Does every grant builder agree with the redeem that will collect it?
 *
 * A grant pins its payees at signature time and a redeem pays whoever was
 * pinned. If one side reads DIRECT_SETTLEMENT_ENABLED and the other does not,
 * every redemption of every grant made under that flag reverts with
 * AllowedCalldataEnforcer:invalid-calldata — after the payer has signed, and
 * only when the first charge runs.
 *
 * That is not hypothetical. It is exactly how the rail went down on
 * 2026-10-28: the grant pinned the MSCA and the charge asked for the EOA, one
 * address apart, discovered seconds after a payer authorized on three chains.
 *
 * The migration is staged path by path, so the rule is not "everything is
 * flag-aware". It is that the two halves of ONE path match.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const FLAG = "directSettlementEnabled";

/** Each payment path: the files that MINT grants, and the files that REDEEM them. */
const PATHS: { name: string; grants: string[]; redeems: string[] }[] = [
  {
    // customer-portal.ts appears in BOTH paths and that is not a mistake: it
    // serves a hosted subscription re-grant AND a rail mandate add-chain, in
    // two handlers. Listing it once would have let one handler convert while
    // the other kept pinning settlement.
    name: "rail",
    grants: ["routes/authorize.ts", "routes/customer-portal.ts"],
    redeems: ["billing/direct-charge.ts"],
  },
  {
    name: "hosted",
    grants: ["routes/delegation.ts", "routes/customer-portal.ts"],
    redeems: ["billing/delegated-renewal.ts", "lib/checkout/cctp-activate.ts"],
  },
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
  for (const p of PATHS) {
    const g = p.grants.filter(aware);
    const r = p.redeems.filter(aware);
    const grantsAware = g.length > 0;
    const redeemsAware = r.length > 0;

    if (grantsAware !== redeemsAware) {
      findings.push(
        `${p.name}: grants ${grantsAware ? "DO" : "do NOT"} read ${FLAG} but redeems ${
          redeemsAware ? "DO" : "do NOT"
        }. Every grant minted under the flag would revert at redemption.\n` +
          `    grants:  ${p.grants.join(", ")}\n` +
          `    redeems: ${p.redeems.join(", ")}`
      );
      continue;
    }
    // Partially converted within a side is the same bug one level down: one
    // of two grant builders pinning creators while the other pins settlement.
    if (grantsAware && g.length !== p.grants.length) {
      findings.push(
        `${p.name}: ${g.length} of ${p.grants.length} grant builders read ${FLAG}. ` +
          `Not converted: ${p.grants.filter((f) => !aware(f)).join(", ")}`
      );
    }
    console.log(
      `  ${p.name.padEnd(8)} grants ${grantsAware ? "direct" : "legacy"} · redeems ${
        redeemsAware ? "direct" : "legacy"
      }`
    );
  }

  if (findings.length === 0) {
    console.log("\nPASS. Every path's grants and redeems agree on the settlement model.");
    return;
  }
  console.log(`\nFAIL. ${findings.length} path(s) half-migrated:\n`);
  for (const f of findings) console.log(`  ${f}\n`);
  process.exitCode = 1;
}

main();
