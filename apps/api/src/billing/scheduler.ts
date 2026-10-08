import cron from "node-cron";
import { transitionTrials, retryWebhooks } from "./engine";
import { runDelegatedRenewalsOnce } from "./delegated-renewal";
import { reconcileMandatesOnce } from "./reconcile-mandates";
import { runMandateExpiryOnce } from "./mandate-expiry";
import { resumeChargeBridges } from "./direct-charge";
import { revokeOrphanGrantsOnce } from "../lib/subscriptions/orphan-grants";

// Registers every billing cron job. Pure side-effect-on-call (no auto-start on
// import) so it can be driven from TWO places without double-registering:
//   • the standalone worker (runner.ts → a separate Railway service), or
//   • the API process itself when BILLING_IN_PROCESS=true (single-service deploy).
// Pick ONE — running both registers the crons twice.
export function startBillingEngine(): void {
  // When the day's billing happens. The passes it is made of run in sequence
  // inside it, so this is the only billing time there is to configure.
  const renewalSchedule = process.env.BILLING_CRON_SCHEDULE ?? "0 2 * * *";

  /**
   * The daily collection, in the order its parts depend on.
   *
   * This was four crons — 01:00, 01:30, 01:45 and BILLING_CRON_SCHEDULE — and
   * the first three were placed to land before the fourth; each said so in its
   * own comment. But only the fourth was configurable, so setting
   * BILLING_CRON_SCHEDULE to anything earlier than 01:45 silently inverted an
   * ordering the code relies on, and nothing would have said so: renewals
   * against trials not yet converted, mandates not yet reconciled, and expiries
   * not yet taken.
   *
   * Running them in one job makes that order structural. It cannot invert,
   * whatever the schedule is set to.
   *
   * Each step is still caught on its own. They were independent jobs before and
   * stay independent in everything but order — a chain that will not answer the
   * reconciler is not a reason to skip the renewals, which is what the pass
   * before this change would have done.
   */
  let passRunning = false;
  cron.schedule(renewalSchedule, async () => {
    // node-cron does not serialise a job against itself, and this one is now
    // long enough to matter on a short schedule. Two passes overlapping would
    // both see the same subscription due and both try to redeem it: the second
    // redeem is refused on-chain by the enforcer's one-per-period rule, but not
    // before it has spent a relayer transaction to find out.
    if (passRunning) {
      console.warn("[cron] billing pass still running — skipping this tick");
      return;
    }
    passRunning = true;
    console.log("[cron] billing pass triggered");
    try {
      // Trials that ended are due today. Convert them before anything asks what
      // is due, or they wait a whole cycle.
      await transitionTrials().catch((e) => console.error("[cron] transitionTrials error:", e));

      // A mandate the subscriber disabled in their wallet is invisible to us
      // until we ask, and attempting it wastes a relayer transaction to learn
      // what a view call answers for free.
      await reconcileMandatesOnce().catch((e) =>
        console.error("[cron] reconcileMandates error:", e)
      );

      // A lapsed mandate should be known to be lapsed before anything tries to
      // charge it.
      await runMandateExpiryOnce().catch((e) => console.error("[cron] mandateExpiry error:", e));

      // One pass, not two: every due subscription is collected by redeeming a
      // delegation on a granted source chain and bridging it to Arc. A
      // subscription that fails stays due and past_due, so the next run of this
      // same pass is its retry.
      await runDelegatedRenewalsOnce().catch((e) =>
        console.error("[cron] delegated renewals error:", e)
      );

      // Housekeeping, and the only step here nothing above depends on — a grant
      // with no subscription is already excluded from every charge path, so this
      // runs last rather than delaying the collection. It retires grants left
      // behind by checkouts that were abandoned or turned away after signing,
      // which are otherwise invisible to the subscriber and re-read from their
      // chain by the reconciler every night until they expire.
      await revokeOrphanGrantsOnce().catch((e) =>
        console.error("[cron] revokeOrphanGrants error:", e)
      );
    } finally {
      passRunning = false;
    }
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

  console.log(`[billing] Cron jobs registered (billing pass: "${renewalSchedule}"). Engine running.`);
}
