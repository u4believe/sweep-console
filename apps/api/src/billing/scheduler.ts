import cron from "node-cron";
import { transitionTrials, retryWebhooks } from "./engine";
import { runDelegatedRenewalsOnce } from "./delegated-renewal";
import { reconcileMandatesOnce } from "./reconcile-mandates";
import { resumeChargeBridges } from "./direct-charge";

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

  // The renewal run. One pass now, not two: every due subscription is collected
  // by redeeming a delegation on a granted source chain and bridging it to Arc.
  // The Arc-first allowance pass is gone with the contract, and with it the
  // separate retry job — a subscription that fails stays due and past_due, so the
  // next run of this same pass is its retry.
  cron.schedule(renewalSchedule, async () => {
    console.log("[cron] renewals triggered");
    await runDelegatedRenewalsOnce().catch((e) =>
      console.error("[cron] delegated renewals error:", e)
    );
  });

  // Rail charges in flight. A charge is pulled, burned, attested and minted; if
  // the mint fails the subscriber's money is already with the relayer, so this
  // pass is the only thing that finishes it. Every 5 minutes rather than daily,
  // because a developer polling GET /v1/charges/:id is waiting on it — and it
  // resumes, never re-pulls.
  cron.schedule("*/5 * * * *", async () => {
    await resumeChargeBridges().catch((e) => console.error("[cron] resumeChargeBridges error:", e));
  });

  cron.schedule("*/10 * * * *", async () => {
    await retryWebhooks().catch((e) => console.error("[cron] retryWebhooks error:", e));
  });

  console.log(`[billing] Cron jobs registered (renewals: "${renewalSchedule}"). Engine running.`);
}
