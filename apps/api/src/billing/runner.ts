import "dotenv/config";
import cron from "node-cron";
import { processRenewals, retryFailed, transitionTrials, retryWebhooks, settleDuePeriods } from "./engine";
import { runDelegatedRenewalsOnce } from "./delegated-renewal";

console.log("[billing-runner] Starting Sweep Console billing engine...");

// Main renewal run — configurable per the addendum (default 2 AM daily)
const renewalSchedule = process.env.BILLING_CRON_SCHEDULE ?? "0 2 * * *";

cron.schedule("0 1 * * *", async () => {
  console.log("[cron] transitionTrials triggered");
  await transitionTrials().catch((e) => console.error("[cron] transitionTrials error:", e));
});

// Renewals run Arc-FIRST, then cross-chain: processRenewals charges every due sub
// from its Arc balance; subs that are Arc-short but enabled cross-chain are left
// due (not failed) and then picked up by the delegated CCTP pass — which pulls one
// period from a granted source chain and bridges it to Arc. Sequential so Arc
// genuinely comes first; the delegated pass no-ops when there are no due mandates.
cron.schedule(renewalSchedule, async () => {
  console.log("[cron] renewals triggered (Arc-first → cross-chain)");
  await processRenewals().catch((e) => console.error("[cron] processRenewals error:", e));
  await runDelegatedRenewalsOnce().catch((e) =>
    console.error("[cron] delegated renewals error:", e)
  );
});

cron.schedule("0 6 * * *", async () => {
  console.log("[cron] retryFailed triggered");
  await retryFailed().catch((e) => console.error("[cron] retryFailed error:", e));
});

// Settlement sweep — releases escrowed first payments whose window has closed.
// Runs hourly so a 24h window settles within at most an hour of the deadline.
cron.schedule("0 * * * *", async () => {
  console.log("[cron] settleDuePeriods triggered");
  await settleDuePeriods().catch((e) => console.error("[cron] settleDuePeriods error:", e));
});

cron.schedule("*/10 * * * *", async () => {
  await retryWebhooks().catch((e) => console.error("[cron] retryWebhooks error:", e));
});

console.log(`[billing-runner] Cron jobs registered (renewals: "${renewalSchedule}"). Engine running.`);
