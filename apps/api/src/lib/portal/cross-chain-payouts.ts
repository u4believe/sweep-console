/**
 * The record of a cross-chain payout, kept in step with 1Click.
 *
 * Two jobs, both of which exist because a cross-chain payout has two legs and
 * only one of them is visible to anything else we own:
 *
 *   - `recordPayoutProgress` asks 1Click where a payout has got to and writes
 *     the answer down, including the one answer 1Click never gives — that a
 *     deposit left the wallet and the route died without ever reaching a
 *     terminal state.
 *   - `payoutView` is the one shape the dashboard, the activity list and the
 *     panel all read, so "failed" means the same thing in all three.
 */
import type { CrossChainPayout } from "@prisma/client";
import { prisma, withRetry } from "../prisma";
import { payoutProgress, chainLabel } from "../chain/near-intents";
import { explorerTxUrl } from "../explorer";

/** States from which nothing more will happen. */
export const TERMINAL = ["succeeded", "refunded", "failed", "stranded"] as const;
export const isTerminal = (status: string): boolean =>
  (TERMINAL as readonly string[]).includes(status);

/**
 * How long after the deposit address goes inactive we stop hoping.
 *
 * 1Click's address is good for roughly three days. Past that plus this grace,
 * a payout that has not reached a terminal state is not slow — nothing is
 * coming, and continuing to show it as "processing" tells a creator to keep
 * waiting for money that will not arrive.
 */
const GRACE_MS = 60 * 60_000;

/**
 * Ask 1Click about one payout and write down what it says.
 *
 * Returns the row as it now stands. Safe to call on a terminal row — it
 * short-circuits — so callers do not have to check first.
 */
export async function recordPayoutProgress(row: CrossChainPayout): Promise<CrossChainPayout> {
  if (isTerminal(row.status)) return row;

  const res = await payoutProgress(row.depositAddress, row.depositMemo);

  if (!res.ok) {
    /**
     * A 404 before the deposit is ordinary: 1Click has nothing to say about
     * an address nobody has paid yet. A 404 AFTER the money left is the case
     * this whole model exists for, and it is still not conclusive on its own
     * — so it is only fatal once the address can no longer be used.
     */
    const dead = row.inactiveAt && Date.now() > row.inactiveAt.getTime() + GRACE_MS;
    if (dead && row.depositedAt) {
      return withRetry(() =>
        prisma.crossChainPayout.update({
          where: { id: row.id },
          data: {
            status: "stranded",
            checkedAt: new Date(),
            failureReason:
              "The deposit left your wallet but the route never completed, and the deposit " +
              "address has expired. Contact support with this payout's id.",
          },
        }),
      );
    }
    if (dead && !row.depositedAt) {
      // Nothing ever left the wallet, so nothing is at risk. Closing it keeps
      // a quote nobody acted on out of the activity list forever.
      return withRetry(() =>
        prisma.crossChainPayout.update({
          where: { id: row.id },
          data: {
            status: "failed",
            checkedAt: new Date(),
            failureReason: "This quote expired before the transfer was sent. No money moved.",
          },
        }),
      );
    }
    return withRetry(() =>
      prisma.crossChainPayout.update({ where: { id: row.id }, data: { checkedAt: new Date() } }),
    );
  }

  const p = res.progress;
  const settled = p.status === "succeeded" || p.status === "refunded" || p.status === "failed";

  return withRetry(() =>
    prisma.crossChainPayout.update({
      where: { id: row.id },
      data: {
        status: p.status,
        upstreamStatus: p.upstream,
        checkedAt: new Date(),
        ...(p.destinationTxHash ? { destinationTxHash: p.destinationTxHash } : {}),
        // Only ever filled in, never corrected: the first hash we see for the
        // deposit is the deposit, and a later differing one would be 1Click
        // contradicting itself rather than new information.
        ...(p.depositTxHash && !row.circleTxHash ? { circleTxHash: p.depositTxHash } : {}),
        ...(p.amountOutMicro !== null ? { amountOut: p.amountOutMicro } : {}),
        ...(p.reason ? { failureReason: p.reason } : {}),
        ...(p.depositTxHash && !row.depositedAt ? { depositedAt: new Date() } : {}),
        ...(settled && !row.settledAt ? { settledAt: new Date() } : {}),
      },
    }),
  );
}

const micro = (v: bigint | null): string | null =>
  v === null ? null : (Number(v) / 1_000_000).toFixed(6);

/** What a creator is told, in one place so every screen says the same thing. */
export function payoutView(row: CrossChainPayout) {
  return {
    id: row.payoutId,
    status: row.status,
    upstream_status: row.upstreamStatus,
    from_chain: row.fromChain,
    to_chain: row.toChain,
    to_label: chainLabel(row.toChain),
    asset: row.asset,
    amount: micro(row.amount),
    amount_out: micro(row.amountOut),
    quoted_out: micro(row.quotedOut),
    recipient: row.recipient,
    /**
     * The deposit's explorer link is on the ORIGIN chain, because that is the
     * leg that happened on a chain we know how to link to. The destination
     * hash is reported as text: we do not keep an explorer for every chain
     * NEAR reaches, and a wrong link is worse than none.
     */
    deposit_tx_hash: row.circleTxHash,
    deposit_explorer_url: explorerTxUrl(row.circleTxHash, row.fromChain),
    destination_tx_hash: row.destinationTxHash,
    failure_reason: row.failureReason,
    created_at: row.createdAt.toISOString(),
    deposited_at: row.depositedAt?.toISOString() ?? null,
    settled_at: row.settledAt?.toISOString() ?? null,
    terminal: isTerminal(row.status),
  };
}
