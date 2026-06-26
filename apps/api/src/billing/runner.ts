// Standalone billing-worker entrypoint. Run as its own process / Railway service:
//   pnpm --filter @sweep/api billing:start   (prod: node dist/billing/runner.js)
//   pnpm --filter @sweep/api billing:run      (dev: tsx)
// For a single-service deploy, set BILLING_IN_PROCESS=true instead and the API
// process starts the same engine — don't run both, or the crons double up.
import "dotenv/config";
import { startBillingEngine } from "./scheduler";

console.log("[billing-runner] Starting Sweep Console billing engine (standalone)...");
startBillingEngine();
