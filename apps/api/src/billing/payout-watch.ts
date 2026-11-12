/**
 * Keep cross-chain payouts honest while nobody is looking.
 *
 * A creator watching the panel gets live status from the route, which asks
 * 1Click on the way past. This exists for everyone else: the tab that was
 * closed, the phone that locked, the payout that went wrong at 3am. Without
 * it, a deposit that left the wallet and never arrived would sit at
 * "processing" until someone happened to reopen the page — and a stranded
 * payout would never be discovered at all, because the state that describes
 * it is one only we can assign.
 *
 * Cheap by construction: one upstream call per non-terminal payout, and there
 * are only ever a handful in flight because routes settle in under two
 * minutes. A payout that is terminal is never asked about again.
 */
import { prisma, withRetry } from "../lib/prisma";
import { recordPayoutProgress, isTerminal } from "../lib/portal/cross-chain-payouts";

/**
 * Rows old enough to be worth a call.
 *
 * A payout quoted seconds ago has nothing to report, and asking about it
 * races the creator's own first poll. Thirty seconds is below the fastest
 * route's estimate, so nothing is left waiting a whole cycle longer than it
 * needs to be.
 */
const MIN_AGE_MS = 30_000;

/**
 * How far back to look.
 *
 * A deposit address dies about three days out; a week of lookback covers that
 * with room for a deploy outage, and bounds the query on a table that only
 * grows.
 */
const LOOKBACK_MS = 7 * 86_400_000;

export async function pollCrossChainPayoutsOnce(): Promise<void> {
  const now = Date.now();
  const rows = await withRetry(() =>
    prisma.crossChainPayout.findMany({
      where: {
        status: { notIn: ["succeeded", "refunded", "failed", "stranded"] },
        createdAt: { gte: new Date(now - LOOKBACK_MS), lte: new Date(now - MIN_AGE_MS) },
      },
      orderBy: { createdAt: "asc" },
      // A cap rather than everything: a backlog should drain over several
      // ticks instead of one pass holding an upstream connection open for
      // minutes.
      take: 50,
    }),
  );

  if (rows.length === 0) return;

  let moved = 0;
  let stranded = 0;
  for (const row of rows) {
    try {
      const after = await recordPayoutProgress(row);
      if (after.status !== row.status) {
        moved += 1;
        if (after.status === "stranded") {
          stranded += 1;
          // Loud, because this is money that left a creator's wallet and did
          // not arrive. It is the one outcome here that needs a human.
          console.error(
            `[payout-watch] STRANDED ${after.payoutId} merchant=${after.merchantId} ` +
              `${after.fromChain}→${after.toChain} deposit=${after.depositAddress}`,
          );
        } else {
          console.log(`[payout-watch] ${after.payoutId} ${row.status} → ${after.status}`);
        }
      }
    } catch (e) {
      // One bad row must not stop the pass; the next tick retries it.
      console.error(`[payout-watch] ${row.payoutId} check failed:`, e);
    }
  }

  const open = rows.filter((r) => !isTerminal(r.status)).length;
  console.log(
    `[payout-watch] checked ${rows.length} (${open} open), ${moved} moved` +
      (stranded > 0 ? `, ${stranded} STRANDED` : ""),
  );
}
