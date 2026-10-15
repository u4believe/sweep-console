// Fail if a merchant-scoped READ of a mode-bearing model forgets the mode.
//
//   pnpm tsx scripts/check-mode-scoping.ts
//
// A merchant holds a test key and a live key at once, so a query made with one
// must not see the other's rows. The filter is one spread — `...merchantScope(req)`
// — and leaving it out fails SILENTLY: nothing errors, no test goes red, a
// merchant simply sees rows they should not, possibly for months.
//
// That is the whole reason this exists. A convention nobody can check is not a
// guarantee, and "add isTestMode to every where clause" is exactly the kind of
// instruction that holds for a year and then does not.
//
// WHAT IT DOES NOT CHECK
//
// Writes. A create stamps isTestMode from the key and has no rows to filter.
// Models with no isTestMode column — Plan, WebhookEndpoint, RenewalDelegation —
// which cannot be scoped until someone decides whether a live merchant sees
// the plans they built while testing, and whether a webhook endpoint belongs
// to one mode. Those are listed below so the omission is deliberate and
// visible rather than forgotten.
//
// And dev.ts, which is mounted only under ENABLE_DEV_ROUTES and is
// unauthenticated anyway.

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/// Models carrying isTestMode. Anything here must be read mode-scoped.
const MODE_BEARING = ["paymentLink", "checkoutSession", "subscription", "payment", "mandate", "charge"];

/// Reads. A create or update has no rows to filter.
const READS = ["findFirst", "findMany", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy"];

/// Known and deliberate: no isTestMode column to filter on yet.
const UNSCOPABLE = ["plan", "webhookEndpoint", "renewalDelegation", "merchant"];

const ROUTES = join(__dirname, "..", "src", "routes");

interface Finding {
  file: string;
  line: number;
  model: string;
  method: string;
}

function main(): void {
  const findings: Finding[] = [];
  const deferred: Finding[] = [];

  for (const name of readdirSync(ROUTES).filter((f) => f.endsWith(".ts"))) {
    // Unauthenticated, dev-only, and never mounted in production.
    if (name === "dev.ts") continue;

    const lines = readFileSync(join(ROUTES, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.includes("merchantId: merchant.id")) continue;

      // Walk back to the prisma/tx call this `where` belongs to.
      let model: string | null = null;
      let method: string | null = null;
      for (let j = i; j >= Math.max(0, i - 25); j--) {
        const m = /(?:prisma|tx)\.([a-zA-Z]+)\.([a-zA-Z]+)/.exec(lines[j]!);
        if (m) {
          model = m[1]!;
          method = m[2]!;
          break;
        }
      }
      if (!model || !method) continue;
      if (!READS.includes(method)) continue;

      const f = { file: name, line: i + 1, model, method };
      if (MODE_BEARING.includes(model)) findings.push(f);
      else if (UNSCOPABLE.includes(model)) deferred.push(f);
    }
  }

  if (deferred.length > 0) {
    console.log(`${deferred.length} read(s) on models with no isTestMode column — deferred, not forgotten:`);
    const byModel = new Map<string, number>();
    for (const d of deferred) byModel.set(d.model, (byModel.get(d.model) ?? 0) + 1);
    for (const [m, n] of [...byModel].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${m.padEnd(20)} ${n}`);
    }
    console.log();
  }

  if (findings.length === 0) {
    console.log("PASS. Every merchant-scoped read of a mode-bearing model carries the mode.");
    return;
  }

  console.log(`FAIL. ${findings.length} read(s) can see the other mode's rows:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  ${f.model}.${f.method}`);
  }
  console.log(`\nReplace \`merchantId: merchant.id\` with \`...merchantScope(req)\`.`);
  process.exitCode = 1;
}

main();
