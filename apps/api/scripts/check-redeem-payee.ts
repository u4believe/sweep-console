/**
 * Does every redeem send funds where the GRANT says, not where config says?
 *
 * A grant signed with a payee rule pins the recipient into an
 * AllowedCalldataEnforcer caveat. Redeem to any other address and the whole
 * transaction reverts with `AllowedCalldataEnforcer:invalid-calldata`. The
 * pinned address is whatever settlement was WHEN THE PAYER SIGNED, which is not
 * necessarily what settlement is now — the EOA and the MSCA generations are
 * both live, and a mandate outlives the configuration that made it.
 *
 * So the only correct source for a redeem's recipient is the signed context,
 * read by settlementTargetFor(chainId, context). Reading it off configuration —
 * getSettlementAddress(), settlementPayeeAddress(), a literal — works until it
 * meets a grant from the other generation.
 *
 * THIS HAS HAPPENED TWICE.
 *
 *   hosted  cctp-activate.ts, fixed, and its comment says the split "moved the
 *           other two redemption sites and left this one behind".
 *   rail    direct-charge.ts, 2026-10-28. chg_03084c773515e9f30fe4 reverted on
 *           Arbitrum seconds after the payer authorized on all three chains:
 *           the grant pinned the MSCA, the charge asked for the EOA. The
 *           comment above it even said "new grants pin `payee` here" — which
 *           was the claim being violated one line later.
 *
 * Two sites found by a production failure is enough. This finds the third.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

/**
 * Call sites whose recipient is deliberately NOT the pinned payee, with the
 * reason. Anything else that passes a recipient is a finding.
 *
 * Keyed by file and by the expression, so moving a line does not silently
 * re-exempt a different call, and changing WHAT is passed un-exempts it.
 */
const ALLOWED: { file: string; recipient: string; why: string }[] = [
  {
    file: "billing/delegated-renewal.ts",
    recipient: "p.creator",
    why: "Arc settles straight to the creator in two redeems. Unreachable today — MetaMask will not sign a delegation on Arc — and an Arc grant pins no payee because settlement is not in its path.",
  },
  {
    file: "billing/delegated-renewal.ts",
    recipient: "treasuryAddress()",
    why: "The fee half of the same Arc path, same reasoning.",
  },
  {
    file: "routes/dev.ts",
    recipient: "d.recipient as Address",
    why: "The dev harness redeems to an address the operator types, on testnet, to probe a grant. Pinning it would defeat the point.",
  },
];

interface Finding {
  file: string;
  line: number;
  recipient: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function main(): void {
  const findings: Finding[] = [];
  let checked = 0;

  for (const full of walk(SRC)) {
    const rel = full.slice(SRC.length + 1).replace(/\\/g, "/");
    // delegation.ts DEFINES the parameter; it does not choose a value for it.
    if (rel === "lib/chain/delegation.ts") continue;
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = /^\s*recipient:\s*(.+?),\s*$/.exec(line);
      if (!m) return;
      const recipient = m[1]!.trim();
      // Not a redeem: the CCTP mint recipient is a different parameter.
      if (/^mint/i.test(recipient)) return;
      // A type declaration, not a call.
      if (/^(Address|Hex|string|z\.)/.test(recipient)) return;
      checked += 1;
      if (recipient.startsWith("settlementTargetFor(")) return;
      /**
       * Or a variable this file assigned FROM settlementTargetFor.
       *
       * cctp-activate.ts resolves the target a few lines above the redeem and
       * passes `settlementTarget.address`, which is correct and which a check
       * reading one line at a time calls a violation. Matching the assignment
       * in the same file is enough: the point is that the address came out of
       * the signed context somewhere, not that it was inlined.
       */
      const base = recipient.replace(/\.address$/, "");
      if (
        /^[A-Za-z_$][\w$]*$/.test(base) &&
        new RegExp(`(const|let)\\s+${base}\\s*(:[^=]+)?=\\s*(await\\s+)?settlementTargetFor\\(`).test(
          lines.join("\n")
        )
      ) {
        return;
      }
      if (ALLOWED.some((a) => rel === a.file && recipient === a.recipient)) return;
      findings.push({ file: rel, line: i + 1, recipient });
    });
  }

  console.log(`  ${checked} redeem recipient(s) examined\n`);
  if (findings.length === 0) {
    console.log(
      "PASS. Every redeem takes its recipient from the signed context, or is listed with a reason."
    );
    return;
  }
  console.log(`FAIL. ${findings.length} redeem(s) choosing a recipient from configuration:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}`);
    console.log(`    recipient: ${f.recipient}`);
    console.log(
      `    -> use settlementTargetFor(chainId, context).address, or add it to ALLOWED with why\n`
    );
  }
  process.exitCode = 1;
}

main();
