// Transaction nonce allocation for the relayer keys.
//
// Every relayer-paid send used to let viem pick its own nonce, which it does by
// asking the node for the pending transaction count. That is only correct while
// exactly one transaction is in flight per key — and that was never true here.
// The billing cron is a sequential loop, but a checkout's CCTP mint runs on a
// request thread and signs with the SAME account on Arc, so a subscriber
// activating during a renewal pass reads the same pending count as the pass.
// Both sign nonce N; one is dropped, or replaces the other.
//
// Allocation happens in a single atomic upsert against relayer_nonces, so the lock
// is held by Postgres for the duration of one statement and is shared by every
// process pointed at this database — a second API replica, the billing worker, and
// the dev harness all queue behind the same row.

import type { Address } from "viem";
import { prisma } from "../prisma";

/**
 * Just the part of a viem public client this module needs.
 *
 * Structural rather than viem's `PublicClient`, whose generics vary with how each
 * caller built its client — every send site here constructs its own, and none of
 * them should have to widen a type to hand it over.
 */
export interface NonceReader {
  getTransactionCount(args: { address: Address; blockTag: "pending" }): Promise<number>;
}

/**
 * Reserve the next nonce for `address` on `chainId`.
 *
 * The stored counter is authoritative, but is raised to the chain's pending count
 * whenever the chain is ahead — that GREATEST is what re-anchors the row after a
 * send that never reached the mempool, and what seeds it on first use.
 */
export async function allocateNonce(
  address: Address,
  chainId: number,
  publicClient: NonceReader
): Promise<number> {
  const addr = address.toLowerCase();

  // Read the chain's view BEFORE the upsert. An RPC round trip inside the
  // statement would hold a pooled Postgres connection for its whole duration, and
  // the Supabase pooler is the one resource this app cannot afford to sit on.
  const pending = await publicClient.getTransactionCount({ address, blockTag: "pending" });

  const rows = await prisma.$queryRaw<{ nextNonce: number }[]>`
    INSERT INTO "relayer_nonces" ("address", "chainId", "nextNonce", "updatedAt")
    VALUES (${addr}, ${chainId}, ${pending + 1}, now())
    ON CONFLICT ("address", "chainId") DO UPDATE
      SET "nextNonce" = GREATEST("relayer_nonces"."nextNonce", ${pending}) + 1,
          "updatedAt" = now()
    RETURNING "nextNonce"
  `;

  return rows[0].nextNonce - 1;
}

/**
 * Hand a reserved nonce back, so the next caller gets it instead of leaving a hole.
 *
 * Only applies when the row is still sitting exactly one past the nonce being
 * returned — if anything else has allocated since, the hole is already downstream
 * of another transaction and closing it here would hand out a duplicate.
 */
export async function releaseNonce(
  address: Address,
  chainId: number,
  nonce: number
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "relayer_nonces"
       SET "nextNonce" = ${nonce}, "updatedAt" = now()
     WHERE "address" = ${address.toLowerCase()}
       AND "chainId" = ${chainId}
       AND "nextNonce" = ${nonce + 1}
  `;
}

/**
 * Might this failure have left a transaction in the mempool?
 *
 * The asymmetry matters. Releasing a nonce that WAS broadcast hands the same nonce
 * to the next send, which either bounces off "nonce too low" or — worse — replaces
 * a real payment mid-flight. Failing to release one leaves a gap, and a stall is
 * strictly safer than a replacement — so anything ambiguous, every transport-level
 * failure where the node may have accepted the transaction and only the response
 * was lost, counts as broadcast and keeps its nonce.
 *
 * BUT THE GAP DOES NOT HEAL ITSELF. An earlier version of this comment claimed
 * GREATEST would re-anchor the row once the node dropped the missing transaction;
 * it cannot, because GREATEST only ever RAISES the stored counter. Once the
 * mempool is empty at that nonce the row stays high forever, every later send is
 * signed with a future nonce, and none of them mine — which on Arc jams
 * receiveOnArc and therefore every cross-chain payment.
 *
 * Observed in practice: six on-chain cancels, two dropped, left the Arc row five
 * ahead of the chain with an empty mempool. Recovery is scripts/nonce-reanchor.ts,
 * which re-anchors only when latest == pending proves nothing is in flight.
 */
function mayHaveBroadcast(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /timeout|timed out|etimedout|socket hang up|econnreset|network|fetch failed|already known|nonce too low|replacement transaction/i.test(
    msg
  );
}

/**
 * Run one send with an allocated nonce, returning the reservation if the send
 * failed without reaching the mempool.
 *
 * Wrap ONLY the broadcast itself — not simulation, gas estimation or the receipt
 * wait. A nonce held across a receipt wait would serialise every send on a chain
 * behind block times, and simulation failures should never consume one at all.
 */
export async function withNonce<T>(
  address: Address,
  chainId: number,
  publicClient: NonceReader,
  send: (nonce: number) => Promise<T>
): Promise<T> {
  const nonce = await allocateNonce(address, chainId, publicClient);
  try {
    return await send(nonce);
  } catch (e) {
    if (!mayHaveBroadcast(e)) {
      // Best effort: a failure to release is a healable gap, not a lost payment.
      await releaseNonce(address, chainId, nonce).catch(() => {});
    }
    throw e;
  }
}

/**
 * Drop the stored counter so the next allocation re-seeds from the chain.
 *
 * An operator escape hatch. allocateNonce heals upward on its own but never
 * downward, so a counter left above the chain's real count — a database restored
 * from a snapshot, a key used outside this app — would hand out unusable nonces
 * until this is called.
 */
export async function resetNonce(address: Address, chainId: number): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "relayer_nonces"
     WHERE "address" = ${address.toLowerCase()} AND "chainId" = ${chainId}
  `;
}
