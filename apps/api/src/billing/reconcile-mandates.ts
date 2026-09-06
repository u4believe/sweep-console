// Reconcile stored mandates against what the chain actually permits.
//
// A subscriber can disable a delegation from their own wallet at any time.
// `disableDelegation` is onlyDeleGator, so we can neither do it for them nor be
// told when they do — the only way to know is to ask. Until this pass existed,
// nothing asked, and the database drifted: of 85 unexpired mandates, 48 were
// disabled on-chain and 22 of those were still marked "active" here. None had
// been redeemed yet, so nothing had broken; the first to come due would have
// failed at redeem with an opaque chain error tracing back to a subscriber
// action weeks earlier.
//
// ONE DIRECTION ONLY. This pass may mark an active mandate revoked; it must
// never mark a revoked one active. A row is revoked here for reasons the chain
// knows nothing about — the subscription was cancelled, the plan closed, the
// merchant refunded — and "the delegation is still enabled on-chain" is not
// evidence that any of those were undone. The 19 rows currently revoked-in-DB
// but live-on-chain are exactly that case, and they must stay revoked.

import type { Address, Hex } from "viem";
import { prisma } from "../lib/prisma";
import { delegationIdentity, isDelegationDisabled } from "../lib/chain/delegation";
import { fireWebhook } from "../lib/webhooks/delivery";

export interface ReconcileOutcome {
  mandateId: string;
  chainId: number;
  result: "revoked" | "unreadable" | "chain_skipped";
  detail?: string;
}

/// How many mandates to check at once. Public testnet RPCs are rate limited and
/// this runs unattended before the renewal pass — there is no reason to rush it.
const CONCURRENCY = 5;

/**
 * Confirm we are talking to the DelegationManager the grants were signed
 * against, before trusting anything it says.
 *
 * Recomputing one stored delegation's hash and comparing it to the value stored
 * at grant time proves the address, the ABI and the struct encoding all still
 * line up. Without this a wrong or redeployed manager could answer
 * `disabledDelegations` with a default `false` — harmless — or, if the storage
 * layout happened to collide, `true` for everything, which would revoke every
 * mandate on that chain in one unattended pass.
 */
async function chainIsTrustworthy(
  chainId: number,
  manager: Address,
  context: Hex,
  expectedHash: string
): Promise<boolean> {
  const { delegationHash } = await delegationIdentity(chainId, manager, context);
  if (!delegationHash) return false;
  return delegationHash.toLowerCase() === expectedHash.toLowerCase();
}

async function inBatches<T, R>(items: T[], size: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(f))));
  }
  return out;
}

/// Check every active mandate against its chain and revoke the ones the
/// subscriber has turned off. Safe to run repeatedly; does nothing to a mandate
/// whose chain state agrees with ours.
export async function reconcileMandatesOnce(): Promise<ReconcileOutcome[]> {
  const mandates = await prisma.renewalDelegation.findMany({
    where: {
      status: "active",
      expiry: { gt: new Date() },
      // Rows granted before identity was recorded cannot be checked without
      // re-deriving the hash per pass. scripts/backfill-delegation-identity.ts
      // fills them; anything still null here is a new grant whose hash read
      // failed, and it will be picked up once that backfill runs again.
      delegationHash: { not: null },
    },
    include: {
      merchant: { select: { merchantId: true } },
      subscription: { select: { externalRef: true, subscriptionId: true } },
    },
  });

  if (mandates.length === 0) return [];

  // One trust check per chain, using a real mandate from that chain.
  const byChain = new Map<number, typeof mandates>();
  for (const m of mandates) byChain.set(m.chainId, [...(byChain.get(m.chainId) ?? []), m]);

  const outcomes: ReconcileOutcome[] = [];
  for (const [chainId, group] of byChain) {
    const probe = group[0];
    let trusted = false;
    try {
      trusted = await chainIsTrustworthy(
        chainId,
        probe.delegationManager as Address,
        probe.context as Hex,
        probe.delegationHash as string
      );
    } catch {
      trusted = false;
    }
    if (!trusted) {
      console.warn(
        `[reconcile] chain ${chainId}: could not reproduce a stored delegation hash from ` +
          `${probe.delegationManager} — skipping ${group.length} mandate(s) rather than acting ` +
          `on answers from a manager we cannot verify`
      );
      for (const m of group) {
        outcomes.push({ mandateId: m.mandateId ?? m.id, chainId, result: "chain_skipped" });
      }
      continue;
    }

    const checked = await inBatches(group, CONCURRENCY, async (m) => {
      try {
        const disabled = await isDelegationDisabled(
          chainId,
          m.delegationManager as Address,
          m.delegationHash as Hex
        );
        return { m, disabled };
      } catch (e) {
        return { m, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
      }
    });

    for (const c of checked) {
      const id = c.m.mandateId ?? c.m.id;
      if ("error" in c && c.error) {
        outcomes.push({ mandateId: id, chainId, result: "unreadable", detail: c.error });
        continue;
      }
      if (!("disabled" in c) || !c.disabled) continue;

      await prisma.renewalDelegation.update({
        where: { id: c.m.id },
        data: { status: "revoked" },
      });
      outcomes.push({ mandateId: id, chainId, result: "revoked" });
      console.log(`[reconcile] ${id} disabled on chain ${chainId} — marked revoked`);

      // The merchant learns now rather than at the next failed charge. Without
      // this their system keeps believing the subscriber is payable, which is
      // the entitlement-drift problem in its purest form.
      if (c.m.merchantId && c.m.merchant) {
        await fireWebhook(
          c.m.merchantId,
          c.m.subscription?.externalRef ?? c.m.externalRef ?? "",
          c.m.merchant.merchantId,
          "mandate.revoked",
          {
            mandate_id: id,
            chain_id: chainId,
            subscription_id: c.m.subscription?.subscriptionId ?? null,
            reason: "disabled_on_chain",
          }
        ).catch((e) => console.error(`[reconcile] webhook failed for ${id}:`, e));
      }
    }
  }

  const revoked = outcomes.filter((o) => o.result === "revoked").length;
  const unreadable = outcomes.filter((o) => o.result === "unreadable").length;
  const skipped = outcomes.filter((o) => o.result === "chain_skipped").length;
  console.log(
    `[reconcile] checked ${mandates.length} active mandate(s): ${revoked} revoked, ` +
      `${unreadable} unreadable, ${skipped} skipped on unverifiable chains`
  );
  return outcomes;
}
