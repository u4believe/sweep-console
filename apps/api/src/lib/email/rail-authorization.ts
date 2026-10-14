/**
 * The one email a rail payer gets when their authorization goes live.
 *
 * WHY THIS EXISTS
 *
 * Per-charge receipts are off by default on the rail: the developer's app is
 * the front door, they already receive charge.succeeded, and a second receipt
 * from a domain the payer may not recognise is noise at best. But switching
 * them off left a hole, because the receipt was carrying something nothing
 * else did — the fact that an open authorization exists, and how to stop it.
 *
 * A rail payer's only other contact from Sweep is the one-time code they typed
 * during authorization. Weeks later, facing a charge they have forgotten
 * agreeing to, that is nothing to work from.
 *
 * So this is sent ONCE, when the mandate goes active, and it carries the three
 * facts a payer needs later: who may charge them, the ceiling and the period,
 * and the link to cancel. Not per charge — per authorization.
 *
 * It is NOT gated on railChargeReceipts. That flag is about whether we duplicate
 * the developer's receipts; this is about a payer being able to find and revoke
 * a standing permission over their own wallet, which is not the developer's to
 * switch off.
 */

import { prisma } from "../prisma";
import { sendEmail, railAuthorizationEmailHtml, type RailAuthorizationData } from "../email";
import { manageUrl } from "../email-shell";

const INTERVAL_NOUN: Record<string, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

function usdc(v: bigint): string {
  return (Number(v) / 1e6).toFixed(2);
}

/**
 * Send it, once, for a mandate that has just become active.
 *
 * Never throws: the authorization is already signed and recorded on chain by
 * the time this runs, and an email provider having a bad minute must not turn
 * a completed authorization into a failed one. Callers do not await it.
 */
export async function sendRailAuthorizationEmail(mandateDbId: string): Promise<void> {
  try {
    const mandate = await prisma.mandate.findUnique({
      where: { id: mandateDbId },
      select: {
        mandateId: true,
        status: true,
        email: true,
        verifiedEmail: true,
        walletAddress: true,
        maxAmount: true,
        interval: true,
        expiresAt: true,
        merchant: { select: { name: true } },
      },
    });
    if (!mandate) return;
    if (mandate.status !== "active") return;

    /**
     * The proved address first.
     *
     * verifiedEmail is an inbox a human answered a code at; `email` is the
     * developer's assertion and may be stale or simply wrong. A mandate with
     * neither has nowhere for this to go, which is worth a log line because a
     * merchant wondering why their payers hear nothing will look here.
     */
    const to = mandate.verifiedEmail ?? mandate.email;
    if (!to) {
      console.log(`[rail-auth] ${mandate.mandateId}: mandate has no email, nothing sent`);
      return;
    }

    const noun = INTERVAL_NOUN[mandate.interval] ?? mandate.interval;
    const ceiling = usdc(mandate.maxAmount);
    /// A mandate carries no currency column: the rail is USDC-only, and the
    /// charges that settle against it say so on their own rows.
    const currency = "USDC";

    const data: RailAuthorizationData = {
      merchantName: mandate.merchant.name,
      ceiling,
      currency,
      interval: mandate.interval,
      walletAddress: mandate.walletAddress,
      expiresAt: mandate.expiresAt,
      manageUrl: manageUrl(),
    };

    console.log(`[rail-auth] sending ${mandate.mandateId} to ${to}`);

    await sendEmail({
      to,
      subject: `You authorized ${mandate.merchant.name} to charge your wallet`,
      html: railAuthorizationEmailHtml(data),
      text:
        `You authorized ${mandate.merchant.name} to charge up to ${ceiling} ${currency} ` +
        `per ${noun} from your wallet ${mandate.walletAddress ?? "(address pending)"}. They choose when to charge within ` +
        `that limit, so there is no fixed date. ` +
        `To cancel, go to ${manageUrl()} — or revoke the permission in your wallet. ` +
        `This authorization expires on its own on ${mandate.expiresAt.toISOString().slice(0, 10)}.`,
    });

    console.log(`[rail-auth] sent ${mandate.mandateId} to ${to}`);
  } catch (e) {
    // Never propagate: the authorization is signed and on chain either way.
    console.warn("[rail-auth] could not send for", mandateDbId, (e as Error).message);
  }
}
