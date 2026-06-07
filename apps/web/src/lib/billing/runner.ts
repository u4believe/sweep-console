/**
 * Billing engine runner — runs as a standalone Node.js process.
 *
 * Start it with:
 *   pnpm billing:run
 *
 * Or deploy as a separate container/worker alongside the Next.js app.
 * Uses node-cron to schedule the three daily jobs.
 */

import cron from "node-cron";
import { processRenewals, retryFailed, transitionTrials, retryWebhooks } from "./engine";

console.log("[billing-runner] Starting SweepConsole billing engine...");

// transitionTrials — daily at 1:00 AM
cron.schedule("0 1 * * *", async () => {
  console.log("[cron] transitionTrials triggered");
  await transitionTrials().catch((e) => console.error("[cron] transitionTrials error:", e));
});

// processRenewals — daily at 2:00 AM
cron.schedule("0 2 * * *", async () => {
  console.log("[cron] processRenewals triggered");
  await processRenewals().catch((e) => console.error("[cron] processRenewals error:", e));
});

// retryFailed — daily at 6:00 AM
cron.schedule("0 6 * * *", async () => {
  console.log("[cron] retryFailed triggered");
  await retryFailed().catch((e) => console.error("[cron] retryFailed error:", e));
});

// retryWebhooks — every 10 minutes
cron.schedule("*/10 * * * *", async () => {
  await retryWebhooks().catch((e) => console.error("[cron] retryWebhooks error:", e));
});

console.log("[billing-runner] Cron jobs registered. Engine running.");
