/**
 * Does step-up gate what it should, and skip what it should?
 *
 * Two things are checked, both of which have bitten:
 *
 *  1. The sandbox exemption actually exempts. It is an early return inside
 *     requireStepUp, so the only way to know it covers EVERY action — rather
 *     than the handful someone thought of — is to drive all of them through
 *     the gate and see that none of them answers the request.
 *
 *  2. The routes the policy claims to guard are actually wired. A factor in
 *     the table guards nothing until requireStepUp sits on the route, and
 *     adding the first is the easy half.
 *
 * No database: the sandbox path returns before any query, and the wiring
 * check reads the route file. An enrol-only refusal needs a merchant row and
 * is left to the running app.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.STEP_UP_ENABLED = "true";

import { requireStepUp, STEP_UP_ACTIONS } from "../src/lib/portal/stepup.js";

type Action = keyof typeof STEP_UP_ACTIONS;

/// Drive one action through the gate and report what the gate did.
async function run(action: Action, isTestMode: boolean): Promise<"next" | "answered"> {
  let outcome: "next" | "answered" = "answered";
  const req = { merchantDbId: "merchant_does_not_exist", isTestMode, header: () => undefined };
  const res = {
    statusCode: 0,
    status(c: number) { this.statusCode = c; return this; },
    json() { return this; },
  };
  await Promise.race([
    requireStepUp(action)(req as never, res as never, () => { outcome = "next"; }),
    // The live pass has no database here. A gate that cannot read the
    // merchant must refuse, so treating "did not call next() in time" as a
    // refusal is the property under test, not a workaround: the question
    // this pass answers is whether the gate fails CLOSED.
    new Promise((r) => setTimeout(r, 2500)),
  ]);
  return outcome;
}

async function main(): Promise<void> {
const failures: string[] = [];
const actions = Object.keys(STEP_UP_ACTIONS) as Action[];

// 1. Sandbox: every action passes, including the ones that alter the shared
//    security record. That is the accepted consequence of the chosen policy,
//    asserted here so it is a decision on the record and not a surprise.
for (const a of actions) {
  if ((await run(a, true)) !== "next") {
    failures.push(`${a}: gated in test mode — the sandbox exemption does not cover it`);
  }
}

// 2. Live: nothing passes unproven. ONE action is probed rather than all
//    fourteen — this path reaches the database, and a script that opens
//    fourteen doomed connections against a pooler trips its circuit breaker
//    and blocks the real service. One is enough to tell whether the gate
//    fails open, which is the only thing this pass can decide without a
//    merchant row to read.
let liveNote = "live: gate refuses when it cannot read the merchant (fails closed)";
if (process.env.SKIP_LIVE_PROBE === "1") {
  liveNote = "live: probe skipped (SKIP_LIVE_PROBE=1)";
} else if ((await run(actions[0], false)) === "next") {
  failures.push(`${actions[0]}: passed unproven on LIVE — the gate fails OPEN`);
}

// 3. The four actions the product promises to gate are wired to their routes.
const SRC = join(import.meta.dirname, "..", "src", "routes", "portal.ts");
const routes = readFileSync(SRC, "utf8");
const WIRED: [string, string][] = [
  ["plan.create", 'post("/plans"'],
  ["rail.request", 'post("/rail/request"'],
  ["apikey.regenerate", "api-keys"],
  ["payout.withdraw", "wallet/circle/withdraw"],
];
for (const [action, needle] of WIRED) {
  const line = routes.split("\n").find((l) => l.includes(needle));
  const guarded = routes.includes(`requireStepUp("${action}")`);
  if (!line) failures.push(`${action}: route matching ${needle} not found`);
  else if (!guarded) failures.push(`${action}: in the policy table but no route calls requireStepUp for it`);
}

if (failures.length === 0) {
  console.log(
    `PASS. ${actions.length} actions: all exempt in test mode, ` +
      `${liveNote}, and the four gated routes are wired.`
  );
} else {
  console.log(`FAIL. ${failures.length} problem(s):\n`);
  for (const f of failures) console.log(`  ${f}`);
  process.exitCode = 1;
}
}

main();
