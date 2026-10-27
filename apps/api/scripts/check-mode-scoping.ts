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

/**
 * Creates, which this missed entirely.
 *
 * "A create stamps isTestMode from the key" was written at the top of this
 * file and was not true of the dashboard. plan.create set no isTestMode at
 * all, so the schema default (true) applied and a plan made on the LIVE
 * dashboard was written as a TEST plan — then vanished, because every read is
 * scoped to the mode that made it. paymentLink.create hardcoded `true` with a
 * "test keys only in beta" comment that outlived the beta.
 *
 * A read that forgets the mode shows rows it should not. A write that forgets
 * it puts rows somewhere nobody will look, which is quieter and worse.
 */
const WRITES = ["create", "createMany", "upsert"];

/// Known and deliberate: no isTestMode column to filter on yet.
const UNSCOPABLE = [
  // A grant has no mode of its own and inherits its parent's — the mandate its
  // sessionId names, or its subscription. reconcile-mandates.ts resolves that
  // before it fires anything.
  "renewalDelegation",
  "merchant",
];

const ROUTES = join(__dirname, "..", "src", "routes");

/// The web app, whose components make CLAIMS about the mode rather than
/// queries against it.
const WEB_SRC = join(__dirname, "..", "..", "web", "src");

/**
 * The PAYER door, which has no merchant in it at all.
 *
 * customer-portal.ts is reached by proving an email, not by a key or a
 * merchant session, so its reads carry neither `merchant.id` nor `dbId` and
 * the patterns below never matched one. Every read there listed BOTH
 * networks' rows, and on 2026-10-19 the live portal showed a payer their
 * Sepolia subscriptions beside real ones, each with a working revoke button.
 *
 * So these files are checked by a different rule: any read of a mode-bearing
 * model must carry the mode somehow — payerScope() or an explicit isTestMode.
 *
 * public.ts was added after the same bug reached a LIVE checkout: it listed a
 * payer's existing subscriptions by merchant and status alone, so the page
 * told them they already subscribed, naming a TESTNET subscription, and
 * offered to replace it. customer-portal.ts was in this list and public.ts was
 * not, which is the whole reason the second one got through.
 */
const PAYER_ROUTES = ["customer-portal.ts", "public.ts"];

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

  // Payer routes: every read of a mode-bearing model, however it is scoped.
  for (const name of PAYER_ROUTES) {
    let lines: string[];
    try {
      lines = readFileSync(join(ROUTES, name), "utf8").split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      const m = /prisma\.([a-zA-Z]+)\.([a-zA-Z]+)\(/.exec(lines[i]!);
      if (!m || !MODE_BEARING.includes(m[1]!) || !READS.includes(m[2]!)) continue;
      let scoped = false;
      for (let j = i; j < Math.min(lines.length, i + 40); j++) {
        if (j > i && /^\s*\}\)[;,]?\s*$/.test(lines[j]!)) break;
        if (/payerScope\(\)|\bisTestMode\s*[,:]/.test(lines[j]!) && !/^\s*\/\//.test(lines[j]!)) {
          scoped = true;
          break;
        }
      }
      if (!scoped) {
        findings.push({
          file: name,
          line: i + 1,
          model: m[1]!,
          method: m[2]!,
          fix: "...payerScope() — a payer read has no merchant id to key on",
        });
      }
    }
  }

  // Second pass: creates of mode-bearing models must stamp isTestMode.
  for (const name of readdirSync(ROUTES).filter((f) => f.endsWith(".ts"))) {
    if (name === "dev.ts") continue;
    const lines = readFileSync(join(ROUTES, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /prisma\.([a-zA-Z]+)\.([a-zA-Z]+)\(/.exec(lines[i]!);
      if (!m || !MODE_BEARING.includes(m[1]!) || !WRITES.includes(m[2]!)) continue;
      // Look ahead through the data block for an isTestMode assignment.
      /**
       * Shorthand counts. The first version of this looked for
       * `isTestMode:` with a colon and reported mandates.ts, plans.ts and
       * webhooks.ts — all three of which stamp it as `isTestMode,`, the
       * object shorthand, one of them eighteen lines into the block.
       *
       * Three false positives on the first run is how a checker gets
       * ignored, so this matches the property however it is written and
       * reads to the end of the create rather than a fixed window.
       */
      let stamped = false;
      for (let j = i; j < Math.min(lines.length, i + 60); j++) {
        if (j > i && /^\s*\}\)[;,]?\s*$/.test(lines[j]!)) break;
        if (/\bisTestMode\s*[,:}]/.test(lines[j]!) && !/^\s*\/\//.test(lines[j]!)) {
          stamped = true;
          break;
        }
      }
      if (!stamped) {
        findings.push({
          file: name,
          line: i + 1,
          model: m[1]!,
          method: m[2]!,
          fix: "stamp isTestMode — the schema default hides the row from its own mode",
        });
      }
    }
  }

  /**
   * Third pass: a component that asserts the mode instead of reading it.
   *
   * `<CheckoutFrame isTestMode />` is `isTestMode={true}` in JSX, and it reads
   * like "pass the variable". PlanPreviewPage did exactly that, so the LIVE
   * dashboard previewed a checkout promising "no real USDC is charged" for a
   * plan that charges real USDC. PortalLayout had the same shape as a
   * hardcoded badge beside the wordmark.
   *
   * Neither is a query, so neither pass above could see it: the data was
   * right and the page said otherwise. A claim about money being fake is
   * worth checking as closely as a claim about whose rows these are.
   */
  const claims: Finding[] = [];
  const walkTsx = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walkTsx(full);
      } else if (e.name.endsWith(".tsx")) {
        const lines = readFileSync(full, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
          // A bare prop, or one asserted true outright.
          const bare = /^\s*isTestMode\s*$/.test(line);
          const literal = /isTestMode=\{\s*true\s*\}/.test(line);
          if (!bare && !literal) return;
          claims.push({
            file: full.slice(WEB_SRC.length + 1),
            line: i + 1,
            model: "isTestMode",
            method: bare ? "bare prop" : "literal true",
            fix: "pass the real value — a bare prop is `={true}`, which claims test mode on live",
          });
        });
      }
    }
  };
  try {
    walkTsx(WEB_SRC);
  } catch {
    /* web app not present — skip rather than fail */
  }
  findings.push(...claims);

  /**
   * Fourth pass: the mode written into the words, not into a prop.
   *
   * Three bugs reached the live console in one day that the pass above could
   * not see, because none of them mentions isTestMode at all:
   *
   *   "Authorization: Bearer test_your_key_here"   a literal key prefix
   *   "only test keys are available ..."           an unconditional claim
   *   profile.isLive ? "Live" : "Test"             the wrong boolean
   *
   * The last is the subtlest and the reason this pass checks identifiers as
   * well as strings: isLive is the ACTIVATION flag — whether the account has
   * been switched on for real money — and testMode is WHICH DEPLOYMENT this
   * is. A merchant on the live console who had not been activated yet was
   * shown "Mode: Test" beside the live key they had just been issued.
   *
   * Heuristic, deliberately: it reads text, so it cannot be sound. It is
   * scoped to the portal, skips comments, and lets a line off when a mode
   * variable is in scope nearby — the window is generous because the guard
   * is usually the enclosing `{testMode && (`, several lines up.
   */
  const WORDS = /\b(test|live)_your_key|only test keys|beta period|test mode is|in test mode\b/i;
  const MODEWORD_TERNARY = /\bisLive\s*\?[^:]*["'`](Live|Test)["'`]/;
  const GUARD = /\b(isTestMode|testMode|keyInfo\.testMode|profile\.testMode)\b/;
  const WINDOW = 14;

  const words: Finding[] = [];
  const walkWords = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walkWords(full); continue; }
      if (!e.name.endsWith(".tsx") && !e.name.endsWith(".ts")) continue;
      const rel = full.slice(WEB_SRC.length + 1);
      // The payer's screens legitimately say "test mode" on the sandbox
      // deployment, where there is no live counterpart to be wrong about.
      if (!rel.includes("portal")) continue;
      const lines = readFileSync(full, "utf8").split("\n");
      /**
       * Track block comments across lines, not just their first one.
       *
       * The prefix test alone said a line was code whenever it sat in the
       * BODY of a `{/* … *\/}` block, because those lines begin with prose.
       * This file is heavily commented, and several of those comments
       * discuss modes by name — so the check reported a page that was
       * correct and invited someone to reword an accurate comment to quiet
       * it. A check that is wrong about its own codebase gets ignored.
       */
      let inBlock = false;
      lines.forEach((line, i) => {
        const t = line.trim();
        const wasInBlock = inBlock;
        const opens = line.lastIndexOf("/*");
        const closes = line.lastIndexOf("*/");
        if (!inBlock && opens !== -1 && closes < opens) inBlock = true;
        else if (inBlock && closes !== -1 && closes > opens) inBlock = false;
        if (wasInBlock || inBlock) return;
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        const ternary = MODEWORD_TERNARY.test(line);
        if (!ternary && !WORDS.test(line)) return;
        const from = Math.max(0, i - WINDOW);
        const near = lines.slice(from, i + 3).join("\n");
        if (!ternary && GUARD.test(near)) return;
        words.push({
          file: rel,
          line: i + 1,
          model: "UI",
          method: ternary ? "isLive used as the mode" : "mode asserted in text",
          fix: ternary
            ? "isLive is the activation flag; the dashboard's mode is testMode"
            : "derive it from testMode, or guard the line with it",
        });
      });
    }
  };
  try { walkWords(WEB_SRC); } catch { /* web app not present */ }
  findings.push(...words);

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
    console.log(
      "PASS. Every read carries the mode, every create stamps it, and nothing in the UI claims it."
    );
    return;
  }

  // Three kinds of finding now, so the headline cannot say "reads".
  console.log(`FAIL. ${findings.length} place(s) where the mode is wrong or missing:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  ${f.model}.${f.method}  -> ${f.fix}`);
  }
  process.exitCode = 1;
}

main();
