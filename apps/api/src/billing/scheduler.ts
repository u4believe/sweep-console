import cron from "node-cron";
import { processRenewals, retryFailed, transitionTrials, retryWebhooks, settleDuePeriods } from "./engine";
import { runDelegatedRenewalsOnce } from "./delegated-renewal";
import { reconcileMandatesOnce } from "./reconcile-mandates";
import { resumeChargeBridges } from "./direct-charge";
import { runIndexerOnce } from "./indexer";

// Registers every billing cron job. Pure side-effect-on-call (no auto-start on
// import) so it can be driven from TWO places without double-registering:
//   • the standalone worker (runner.ts → a separate Railway service), or
//   • the API process itself when BILLING_IN_PROCESS=true (single-service deploy).
// Pick ONE — running both registers the crons twice.
export function startBillingEngine(): void {
  // Main renewal run — configurable (default 2 AM daily).
  const renewalSchedule = process.env.BILLING_CRON_SCHEDULE ?? "0 2 * * *";

  cron.schedule("0 1 * * *", async () => {
    console.log("[cron] transitionTrials triggered");
    await transitionTrials().catch((e) => console.error("[cron] transitionTrials error:", e));
  });

  // Deliberately BEFORE the renewal run: a mandate the subscriber disabled in
  // their wallet is invisible to us until we ask, and attempting it wastes a
  // relayer transaction to learn what a view call answers for free. Reconciling
  // first means the renewal pass only sees mandates that can still be redeemed.
  cron.schedule("30 1 * * *", async () => {
    console.log("[cron] reconcileMandates triggered");
    await reconcileMandatesOnce().catch((e) => console.error("[cron] reconcileMandates error:", e));
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

  // Rail charges in flight. A charge is pulled, burned, attested and minted; if
  // the mint fails the subscriber's money is already with the relayer, so this
  // pass is the only thing that finishes it. Every 5 minutes rather than daily,
  // because a developer polling GET /v1/charges/:id is waiting on it — and it
  // resumes, never re-pulls.
  cron.schedule("*/5 * * * *", async () => {
    await resumeChargeBridges().catch((e) => console.error("[cron] resumeChargeBridges error:", e));
  });

  // Settlement sweep — releases escrowed first payments whose window has closed.
  // Runs hourly so a 24h window settles within at most an hour of the deadline.
  cron.schedule("0 * * * *", async () => {
    console.log("[cron] settleDuePeriods triggered");
    await settleDuePeriods().catch((e) => console.error("[cron] settleDuePeriods error:", e));
  });

  // Event indexer — reconciles contract state the API never saw (a subscriber
  // calling cancelSubscription() directly, or a tx that landed after our commit
  // failed). Runs often: until it catches a cancel, the DB still shows the
  // subscription active and its escrow pending.
  cron.schedule("*/5 * * * *", async () => {
    await runIndexerOnce().catch((e) => console.error("[cron] indexer error:", e));
  });

  cron.schedule("*/10 * * * *", async () => {
    await retryWebhooks().catch((e) => console.error("[cron] retryWebhooks error:", e));
  });

  console.log(`[billing] Cron jobs registered (renewals: "${renewalSchedule}"). Engine running.`);
}
