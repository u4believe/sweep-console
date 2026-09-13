// Mandate expiry: the warning, and the lapse.
//
// A mandate carries a hard expiry the payer signed. Enforcement was never the
// problem — planCharge refuses an expired one and no money can move past it —
// but nothing ANNOUNCED it. The first signal a developer got was a charge
// failing with mandate_expired, which is a missed payment caused by a deadline
// rather than by anything the payer did. Worse, recovery is not something the
// developer can do alone: only the payer can sign a new mandate, so finding out
// at charge time means finding out a payment late and then needing a redirect
// and a wallet signature to recover.
//
// So: warn once before, announce once after. Both are one-shot, recorded on the
// row rather than inferred from dates, because a daily reminder for a week is
// how a useful signal becomes one people filter out.
//
// Only ACTIVE mandates. A pending one lapsing means the payer never signed at
// all, which is a different event with a different remedy, and firing "expired"
// for it would tell a developer their working authorization died when they never
// had one.

import { prisma } from "../lib/prisma";
import { fireWebhook } from "../lib/webhooks/delivery";

/// How long before expiry the warning goes out. Long enough to reach a human and
/// get a signature back; short enough that it still reads as urgent.
function warningLeadDays(): number {
  const raw = Number(process.env.MANDATE_EXPIRY_WARNING_DAYS ?? "7");
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

export interface ExpiryOutcome {
  mandateId: string;
  result: "warned" | "expired";
}

const SELECT = {
  id: true,
  mandateId: true,
  externalRef: true,
  merchantId: true,
  expiresAt: true,
  maxAmount: true,
  interval: true,
  walletAddress: true,
  merchant: { select: { merchantId: true } },
} as const;

export async function runMandateExpiryOnce(): Promise<ExpiryOutcome[]> {
  const now = new Date();
  const outcomes: ExpiryOutcome[] = [];

  // ── 1. Lapsed ───────────────────────────────────────────────────────────────
  // Status is the guard, not the date: an already-expired row has status
  // "expired" and drops out of this query, so the event fires exactly once.
  const lapsed = await prisma.mandate.findMany({
    where: { status: "active", expiresAt: { lte: now } },
    select: SELECT,
  });

  for (const m of lapsed) {
    await prisma.mandate.update({
      where: { id: m.id },
      data: { status: "expired", expiredAt: now },
    });
    outcomes.push({ mandateId: m.mandateId, result: "expired" });
    console.log(`[mandate-expiry] ${m.mandateId} expired (deadline ${m.expiresAt.toISOString()})`);

    await fireWebhook(m.merchantId, m.externalRef, m.merchant.merchantId, "mandate.expired", {
      mandate_id: m.mandateId,
      external_ref: m.externalRef,
      wallet_address: m.walletAddress,
      expired_at: m.expiresAt.toISOString(),
      // Said plainly because the remedy is not on the developer's side: they
      // cannot extend a mandate, only the payer can sign a new one.
      recovery: "Create a new mandate and send the payer its authorization_url.",
    }).catch((e) => console.error(`[mandate-expiry] expired webhook failed for ${m.mandateId}:`, e));
  }

  // ── 2. Expiring soon ────────────────────────────────────────────────────────
  const horizon = new Date(now.getTime() + warningLeadDays() * 86_400_000);
  const expiring = await prisma.mandate.findMany({
    where: {
      status: "active",
      expiresAt: { gt: now, lte: horizon },
      expiringNotifiedAt: null,
    },
    select: SELECT,
  });

  for (const m of expiring) {
    await prisma.mandate.update({ where: { id: m.id }, data: { expiringNotifiedAt: now } });
    const daysLeft = Math.max(0, Math.ceil((m.expiresAt.getTime() - now.getTime()) / 86_400_000));
    outcomes.push({ mandateId: m.mandateId, result: "warned" });
    console.log(`[mandate-expiry] ${m.mandateId} expires in ${daysLeft}d — warned`);

    await fireWebhook(m.merchantId, m.externalRef, m.merchant.merchantId, "mandate.expiring", {
      mandate_id: m.mandateId,
      external_ref: m.externalRef,
      wallet_address: m.walletAddress,
      expires_at: m.expiresAt.toISOString(),
      days_remaining: daysLeft,
      recovery: "Create a new mandate and send the payer its authorization_url before this one lapses.",
    }).catch((e) => console.error(`[mandate-expiry] expiring webhook failed for ${m.mandateId}:`, e));
  }

  if (outcomes.length > 0) {
    const warned = outcomes.filter((o) => o.result === "warned").length;
    const expired = outcomes.filter((o) => o.result === "expired").length;
    console.log(`[mandate-expiry] ${expired} expired, ${warned} warned (${warningLeadDays()}d lead)`);
  }
  return outcomes;
}
