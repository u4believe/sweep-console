// Asking payers to sign again after the delegate moved.
//
// This is the half of the migration that reaches the people it affects. A
// wallet permission names its collector at signature time, so moving the
// collector leaves every existing permission valid and redeemable by nobody.
// There is no retry, no server-side migration and no way to do it on their
// behalf: the payer signs again or the subscription collects nothing.
//
// It is deliberately NOT part of the renewal path. A renewal that cannot
// collect would otherwise look like a payment failure and start dunning
// someone for a change they did not make — so this is run once, on purpose,
// against a known list, by an operator who can see what it is about to do.
//
// Never throws for one recipient. One bad address must not stop the other
// seventeen, and the whole point is that the list gets through.
import { prisma } from "../prisma";
import { sendEmail, reauthorizationEmailHtml } from "../email";
import { chainKeyForIdAnyNetwork, isMainnetChainId } from "../gateway/chains";

const usdc = (v: bigint) => (Number(v) / 1_000_000).toFixed(2);

export interface ReauthResult {
  /** Payers emailed. */
  sent: number;
  /** Payers we could not reach, with why. */
  failed: { to: string; reason: string }[];
  /** Grants whose payer has no email on file — a rail mandate, usually. */
  unreachable: number;
}

/**
 * Email every payer whose active grant names a delegate we no longer use.
 *
 * `delegates` is the CURRENT address per mode, resolved by the caller rather
 * than here: delegateAddressForNewGrant throws when both delegate flags are
 * set, and a sweep that emailed everyone because it could not resolve an
 * address would be worse than one that refused to run.
 *
 * `dryRun` sends nothing and reports what it would have done. Default,
 * because the alternative default mails real subscribers.
 */
export async function notifyStaleGrantPayers(opts: {
  delegates: Record<string, string>;
  mainnet: boolean;
  dryRun?: boolean;
}): Promise<ReauthResult> {
  const dryRun = opts.dryRun !== false;
  const out: ReauthResult = { sent: 0, failed: [], unreachable: 0 };

  const grants = (
    await prisma.renewalDelegation.findMany({
      where: { status: "active" },
      select: {
        chainId: true,
        delegateAddress: true,
        mode: true,
        periodAmount: true,
        subscription: {
          select: {
            subscriberEmail: true,
            amount: true,
            interval: true,
            plan: { select: { name: true, interval: true, amount: true } },
            merchant: { select: { name: true } },
          },
        },
        /**
         * A RAIL GRANT POINTS AT ITS MANDATE THROUGH sessionId.
         *
         * Not through `mandateId`, which is this row's own legacy public id
         * and is @unique — it cannot address a mandate, because a mandate has
         * one grant per chain. lib/rail.ts says it plainly:
         * mandateGrantsWhere(id) is { sessionId: id, mode: "external" }.
         *
         * Reading mandateId instead resolved nothing, which did not look like
         * a bug: the sweep reported every rail payer "unreachable" and sent
         * them nothing, which is exactly what it would report if those
         * mandates genuinely had no email.
         */
        sessionId: true,
      },
    })
  ).filter((g) => isMainnetChainId(g.chainId) === opts.mainnet);

  const stale = grants.filter(
    (g) => g.delegateAddress.toLowerCase() !== (opts.delegates[g.mode] ?? opts.delegates.hosted)
  );

  /**
   * The mandates behind the rail grants, in one query.
   *
   * A rail grant has no subscription: the payer is whoever authorized the
   * mandate. Without this the sweep reached nobody on the rail — every
   * mainnet grant on this deployment is a mandate, so "would email 0 payers"
   * was the whole answer while eight people needed telling.
   */
  const mandateIds = [
    ...new Set(stale.filter((g) => g.mode === "external").map((g) => g.sessionId).filter(Boolean)),
  ] as string[];
  const mandates = new Map(
    (
      await prisma.mandate.findMany({
        where: { mandateId: { in: mandateIds } },
        select: {
          mandateId: true,
          email: true,
          verifiedEmail: true,
          maxAmount: true,
          interval: true,
          merchant: { select: { name: true } },
        },
      })
    ).map((m) => [m.mandateId, m])
  );

  // One email per PAYER, not per grant. A subscriber authorized on four
  // chains has four stale grants and one inbox, and four identical emails
  // about the same subscription reads as a malfunction.
  const byPayer = new Map<
    string,
    { chains: string[]; amount: bigint; interval: string; plan: string | null; merchant: string }
  >();
  for (const g of stale) {
    const sub = g.subscription;
    const man = g.sessionId ? (mandates.get(g.sessionId) ?? null) : null;

    /**
     * The proved address first, then the developer's, then the subscriber's.
     *
     * Same precedence the rail receipt uses, and for the same reason: a
     * verifiedEmail is an inbox a human answered a code at, while the
     * developer's is an assertion that may be stale. A grant with neither
     * cannot be reached by us at all — only by the creator.
     */
    const to = man?.verifiedEmail ?? man?.email ?? sub?.subscriberEmail ?? null;
    if (!to) {
      out.unreachable++;
      continue;
    }
    const key = to.toLowerCase();
    const row = byPayer.get(key) ?? {
      chains: [],
      // A mandate has a ceiling rather than a price — it is the most the
      // payer allowed, not what they are charged, and saying so is honest.
      amount: sub?.amount ?? sub?.plan?.amount ?? man?.maxAmount ?? g.periodAmount ?? 0n,
      interval: sub?.interval ?? sub?.plan?.interval ?? man?.interval ?? "monthly",
      plan: sub?.plan?.name ?? null,
      merchant: sub?.merchant?.name ?? man?.merchant?.name ?? "the creator",
    };
    const key2 = chainKeyForIdAnyNetwork(g.chainId);
    if (key2 && !row.chains.includes(key2)) row.chains.push(key2);
    byPayer.set(key, row);
  }

  for (const [to, row] of byPayer) {
    const pretty = row.chains
      .map((c) => c.charAt(0).toUpperCase() + c.slice(1))
      .sort();
    if (dryRun) {
      console.log(
        `  [dry-run] would email ${to} — ${row.plan ?? "subscription"} with ${row.merchant}, ` +
          `${usdc(row.amount)} USDC / ${row.interval}, chains ${pretty.join(", ") || "none"}`
      );
      out.sent++;
      continue;
    }
    try {
      await sendEmail({
        to,
        subject: `Action needed: re-approve renewals for ${row.plan ?? row.merchant}`,
        html: reauthorizationEmailHtml({
          merchantName: row.merchant,
          planName: row.plan,
          amount: usdc(row.amount),
          currency: "USDC",
          interval: row.interval,
          chains: pretty,
        }),
        text:
          `Your payment permission for ${row.plan ?? "your subscription"} with ${row.merchant} ` +
          `needs signing again. We moved the account that collects renewals, and a wallet ` +
          `permission names its collector when you sign it — so yours can no longer be used by ` +
          `anyone, including us. No money has moved and none can until you approve renewals ` +
          `again. Nothing was charged and nothing is owed. ` +
          `The amount stays ${usdc(row.amount)} USDC per ${row.interval}. ` +
          `Re-approve at ${process.env.APP_URL ?? "https://sweepconsole.xyz"}/manage. ` +
          `If you would rather stop, do nothing — the old permission is already inert.`,
      });
      out.sent++;
    } catch (e) {
      out.failed.push({ to, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return out;
}
