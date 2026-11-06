/**
 * Does the owner key still pay for anything?
 *
 * The MSCA owner's job is to SIGN. The gas payer's job is to HOLD NATIVE
 * TOKEN and submit. Keeping them apart is the entire reason a KMS-backed
 * owner can live on a chain without ever being funded there.
 *
 * It is a one-word regression. `payer.address` and `input.owner.address` are
 * interchangeable to the compiler and to every test that runs against a
 * funded owner — the difference only shows up in production, as an owner key
 * that mysteriously needs topping up, or a redeem that fails because the key
 * guarded by a KMS has an empty balance by design.
 *
 * So: in the self-bundler, input.owner may be read for the signing account
 * and for the fallback, and nowhere else.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "src/lib/chain/delegate-msca.ts";

/** Uses of input.owner that are legitimate. */
const ALLOWED = [
  // The fallback: with no relayer configured the owner pays, as before.
  /const payer: LocalAccount = getGasRelayerAccount\(\) \?\? input\.owner;/,
  // Deriving / signing for the smart account. This is the owner's actual job.
  /toCircleSmartAccount\(\{[^}]*owner: input\.owner as any[^}]*\}\)/,
];

/** Things that must never be fed the owner. */
const GAS_SINKS: { label: string; re: RegExp }[] = [
  { label: "balance read", re: /getBalance\(\{\s*address:\s*input\.owner\.address/ },
  { label: "nonce reservation", re: /withNonce\(\s*input\.owner\.address/ },
  { label: "handleOps beneficiary", re: /handleOps"?,?\s*args:\s*\[\[?\w+\]?,\s*input\.owner\.address\]/ },
  { label: "wallet client / submitter", re: /createWalletClient\(\{\s*account:\s*input\.owner/ },
  { label: "topUpAmount owner field", re: /owner:\s*input\.owner\.address/ },
];

function main(): void {
  const src = readFileSync(join(import.meta.dirname, "..", FILE), "utf8");
  const findings: string[] = [];

  for (const sink of GAS_SINKS) {
    const m = src.match(sink.re);
    if (m) {
      const line = src.slice(0, src.indexOf(m[0])).split("\n").length;
      findings.push(`${FILE}:${line} — ${sink.label} uses input.owner, not payer`);
    }
  }

  // Every surviving mention must be one of the allowed shapes.
  const lines = src.split("\n");
  lines.forEach((l, i) => {
    if (!l.includes("input.owner")) return;
    if (/^\s*(\/\/|\*)/.test(l)) return;
    if (ALLOWED.some((re) => re.test(l))) return;
    findings.push(`${FILE}:${i + 1} — unreviewed use of input.owner: ${l.trim().slice(0, 72)}`);
  });

  const payerUses = (src.match(/payer\.address/g) ?? []).length;
  console.log(`  payer.address used ${payerUses}×; input.owner limited to signing + fallback`);

  if (findings.length === 0) {
    console.log("\nPASS. The owner signs; the gas payer pays.");
    return;
  }
  console.log(`\nFAIL. ${findings.length} place(s) make the owner pay:\n`);
  for (const f of findings) console.log(`  ${f}`);
  process.exitCode = 1;
}

main();
