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
// Models with no isTestMode column. RenewalDelegation is the only real one
// left: a grant inherits its parent's mode rather than carrying its own.
// Plan and WebhookEndpoint were here and are not any more.
//
// And dev.ts, which is mounted only under ENABLE_DEV_ROUTES and is
// unauthenticated anyway.

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/// Models carrying isTestMode. Anything here must be read mode-scoped.
const MODE_BEARING = [
  "paymentLink", "checkoutSession", "subscription", "payment", "mandate", "charge",
  // Added once they gained the column. A plan built while testing is not a
  // live plan, and an endpoint's signing secret is per endpoint — one serving
  // both modes would sign live and test deliveries with the same secret.
  "plan", "webhookEndpoint",
];

/// Reads. A create or update has no rows to filter.
const READS = ["findFirst", "findMany", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy"];

/// Known and deliberate: no isTestMode column to filter on yet.
const UNSCOPABLE = [
  // A grant has no mode of its own and inherits its parent's — the mandate its
  // sessionId names, or its subscription. reconcile-mandates.ts resolves that
  // before it fires anything.
  "renewalDelegation",
  "merchant",
];

const ROUTES = join(__dirname, "..", "src", "routes");

/**
 * The two doors, and how each names the merchant.
 *
 * The API is key-authed and says `merchantId: merchant.id`; the dashboard is
 * session-authed and says `merchantId: dbId`. Both leak the same way if the
 * mode is left off, and the dashboard is the easier one to forget because
 * there is no key to remind you a mode exists.
 */
const RAW_PATTERNS = [
  { needle: "merchantId: merchant.id", fix: "...merchantScope(req)" },
  { needle: "merchantId: dbId", fix: "...portalScope(req)" },
];

interface Finding {
  file: string;
  line: number;
  model: string;
  method: string;
  fix: string;
}

function main(): void {
  const findings: Finding[] = [];
  const deferred: Finding[] = [];

  for (const name of readdirSync(ROUTES).filter((f) => f.endsWith(".ts"))) {
    // Unauthenticated, dev-only, and never mounted in production.
    if (name === "dev.ts") continue;

    const lines = readFileSync(join(ROUTES, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = RAW_PATTERNS.find((p) => lines[i]!.includes(p.needle));
      if (!raw) continue;

      /**
       * Walk back to the prisma/tx call this belongs to — but only through a
       * `where`.
       *
       * Without that condition the walk attributes any `merchantId:` to
       * whatever query happened to appear above it, and
       * createCheckoutSession({ merchantId, ... }) got reported as a
       * plan.findFirst that needed scoping. A checker that cries wolf is
       * worse than none, because the first false positive is what teaches
       * everyone to pass the flag that silences it.
       */
      let model: string | null = null;
      let method: string | null = null;
      for (let j = i; j >= Math.max(0, i - 25); j--) {
        // A closing `});` between here and the query means they are different
        // statements. Without this the walk attributed
        // createCheckoutSession({ merchantId, ... }) to the plan.findFirst
        // above it — and a checker that cries wolf is worse than none, since
        // the first false positive teaches everyone to silence it.
        if (j < i && /^\s*\}\)[;,]?\s*$/.test(lines[j]!)) break;
        const m = /(?:prisma|tx)\.([a-zA-Z]+)\.([a-zA-Z]+)/.exec(lines[j]!);
        if (m) {
          model = m[1]!;
          method = m[2]!;
          break;
        }
      }
      if (!model || !method) continue;
      if (!READS.includes(method)) continue;

      const f = { file: name, line: i + 1, model, method, fix: raw.fix };
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
    console.log(`  ${f.file}:${f.line}  ${f.model}.${f.method}  -> ${f.fix}`);
  }
  process.exitCode = 1;
}

main();
