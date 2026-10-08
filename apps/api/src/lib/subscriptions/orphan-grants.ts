// Grants that belong to no subscription, and what to do about them.
//
// A grant is bound to its checkout SESSION when it is signed, and only linked to
// a subscription when that checkout completes (complete.ts). A checkout that is
// abandoned, or refused at activation after the signature, therefore leaves a
// row behind with no subscription, status "active", and a delegation live in the
// subscriber's wallet for its full year.
//
// Nothing charges them — every charge path filters on a subscription. They are
// not harmless either: the portal lists grants per subscription, so one
// belonging to none is invisible there and the subscriber has no way to turn it
// off short of acting in their own wallet, and reconcileMandates re-reads each
// from its chain every night until it expires.
//
// Neither function touches a chain. disableDelegation is onlyDeleGator: the
// signed permission stays in the wallet whatever the database says, and only its
// owner can remove it. What these do is stop the database claiming a grant is
// live when nothing will ever redeem it.
import { prisma } from "../prisma";

/**
 * Revoke the unlinked grants of one checkout session.
 *
 * For a refusal that the session cannot recover from — the subscriber is already
 * on this tier, or the wallet is already paying at this merchant. Both are
 * decided after the grant is signed, so without this every turned-away checkout
 * leaves another orphan.
 *
 * Scoped to `subscriptionId: null` so it can never touch a grant that a
 * completed checkout already linked.
 */
export async function revokeSessionGrants(sessionId: string, reason: string): Promise<number> {
  const { count } = await prisma.renewalDelegation.updateMany({
    where: { sessionId, subscriptionId: null, status: "active" },
    data: { status: "revoked" },
  });
  if (count > 0) {
    console.log(`[grants] ${sessionId}: revoked ${count} unlinked grant(s) — ${reason}`);
  }
  return count;
}

export interface OrphanGrant {
  id: string;
  grantId: string | null;
  chainId: number;
  walletAddress: string;
  periodAmount: bigint;
  expiry: Date;
  createdAt: Date;
  sessionId: string | null;
}

/**
 * Orphaned hosted grants whose checkout can no longer complete.
 *
 * A grant whose session is still open and unexpired is a payment in progress,
 * and revoking it would break the checkout the subscriber is in the middle of.
 * Everything else — session expired, closed, or gone — is settled.
 */
export async function findSettledOrphanGrants(): Promise<{
  settled: OrphanGrant[];
  inFlight: OrphanGrant[];
}> {
  const orphans = await prisma.renewalDelegation.findMany({
    // Rail mandates carry no subscription by design and dedupe by mandateId.
    where: { status: "active", subscriptionId: null, mode: "hosted" },
    select: {
      id: true, grantId: true, chainId: true, walletAddress: true,
      periodAmount: true, expiry: true, createdAt: true, sessionId: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (orphans.length === 0) return { settled: [], inFlight: [] };

  const sessions = await prisma.checkoutSession.findMany({
    where: { sessionId: { in: orphans.map((o) => o.sessionId).filter((s): s is string => !!s) } },
    select: { sessionId: true, status: true, expiresAt: true },
  });
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));

  const now = new Date();
  const settled: OrphanGrant[] = [];
  const inFlight: OrphanGrant[] = [];
  for (const o of orphans) {
    const s = o.sessionId ? byId.get(o.sessionId) : undefined;
    // A session row that is gone is as settled as one that expired.
    (!s || s.status !== "open" || s.expiresAt < now ? settled : inFlight).push(o);
  }
  return { settled, inFlight };
}

/// Sweep them. Returns how many were revoked.
export async function revokeOrphanGrantsOnce(): Promise<number> {
  const { settled, inFlight } = await findSettledOrphanGrants();
  if (settled.length === 0) {
    if (inFlight.length > 0) {
      console.log(`[grants] ${inFlight.length} orphaned grant(s), all on checkouts still in progress`);
    }
    return 0;
  }
  const { count } = await prisma.renewalDelegation.updateMany({
    where: { id: { in: settled.map((o) => o.id) } },
    data: { status: "revoked" },
  });
  console.log(
    `[grants] revoked ${count} orphaned grant(s) on settled checkouts` +
      (inFlight.length > 0 ? `; left ${inFlight.length} in progress` : "")
  );
  return count;
}
