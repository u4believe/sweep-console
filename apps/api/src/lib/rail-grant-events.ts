/**
 * Telling a merchant that a payer ADDED a chain.
 *
 * `grant.revoked` reports a chain leaving a live mandate. Nothing reported one
 * arriving, so a developer's picture of what is chargeable could only ever
 * shrink: a payer who authorized Base and later added Arbitrum from their
 * portal was chargeable on two while the merchant believed one. The same
 * entitlement drift `grant.revoked` was written to prevent, pointing the other
 * way.
 *
 * There are two routes a payer can take and neither said anything. The
 * authorization link's /complete explicitly early-returns on an already-active
 * mandate "rather than firing the event twice", which is right for
 * `mandate.authorized` and left nothing in its place; the portal's
 * mandates/:id/grant fired no webhook at all.
 *
 * WHEN IT DOES NOT FIRE
 *
 * Not during the first authorization. A payer signing three chains at checkout
 * produces one `mandate.authorized` carrying all three in `chain_ids`, and
 * three `grant.added` events beside it would be noise describing the same
 * thing. So this is only for a chain joining a mandate that is ALREADY active.
 *
 * Not on a re-signature either. Re-signing a chain replaces its grant rather
 * than adding one, and nothing about what is chargeable has changed.
 */

import { prisma } from "./prisma";
import { fireWebhook } from "./webhooks/delivery";
import { chainKeyForId } from "./gateway/chains";
import { mandateGrantsWhere } from "./rail";

/**
 * Fire `grant.added` for a chain that just joined a live mandate.
 *
 * Never throws and is not awaited by its callers: the grant is signed and
 * stored by the time this runs, and a slow endpoint must not fail a payer's
 * authorization.
 */
export async function notifyGrantAdded(input: {
  /** The mandate's PUBLIC id — what the developer knows it by. */
  mandateId: string;
  chainId: number;
  grantId: string | null;
}): Promise<void> {
  try {
    const mandate = await prisma.mandate.findUnique({
      where: { mandateId: input.mandateId },
      select: {
        mandateId: true,
        status: true,
        isTestMode: true,
        externalRef: true,
        merchantId: true,
        merchant: { select: { merchantId: true } },
      },
    });
    // Only a mandate already live. A pending one is mid-first-authorization,
    // and mandate.authorized will carry every chain it ends up with.
    if (!mandate || mandate.status !== "active") return;
    if (!mandate.merchantId || !mandate.merchant) return;

    const rows = await prisma.renewalDelegation.findMany({
      where: { ...mandateGrantsWhere(mandate.mandateId), status: "active" },
      select: { chainId: true },
    });
    const grantedChains = [
      ...new Set(rows.map((r) => chainKeyForId(r.chainId) ?? String(r.chainId))),
    ].sort();

    await fireWebhook(
      mandate.merchantId,
      mandate.externalRef,
      mandate.merchant.merchantId,
      "grant.added",
      {
        mandate_id: mandate.mandateId,
        chain_id: input.chainId,
        grant_id: input.grantId,
        /**
         * The whole chargeable set after the change, not just the new chain —
         * the same field `grant.revoked` carries, so one handler can write it
         * straight down without reasoning about deltas.
         */
        granted_chains: grantedChains,
        mandate_still_active: true,
      },
      // The mandate's mode, not the caller's: a test mandate's events are
      // test events wherever they are triggered from.
      mandate.isTestMode
    );
    console.log(
      `[rail/grant-added] ${mandate.mandateId} gained chain ${input.chainId} — now ${grantedChains.join(", ")}`
    );
  } catch (e) {
    console.warn("[rail/grant-added] could not notify for", input.mandateId, (e as Error).message);
  }
}
