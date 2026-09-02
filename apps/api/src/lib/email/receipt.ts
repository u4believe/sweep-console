// Sending the payment receipt.
//
// Heavily guarded, and it never throws: a failed email must not fail a charge
// that already succeeded on-chain. It resolves whatever happens.
//
// Because of that, call sites choose how to wait. The billing engine and the
// settlement indexer use `void sendPaymentReceipt(id)` — they are long-running
// loops and must not serialise on the mail provider. Checkout AWAITS it: it runs
// inside a request handler, where a floating promise lives only as long as the
// process and can be dropped by a reload or a deploy.
//
// The guards live here, not at the call sites: a caller that hands over a
// pending, zero-value or refund payment gets a no-op instead of a wrong email.

import { prisma } from "../prisma";
import { sendEmail, receiptEmailHtml, type ReceiptEmailData } from "../email";
import { supportedSourceChains } from "../gateway/chains";

/// Payment.type values that represent money moving FROM a subscriber TO a
/// merchant. "refund" and "settlement" are not receipts to the subscriber.
const CHARGE_TYPES = new Set(["initial", "renewal"]);

/// Display names for Payment.chain, which stores the gateway's own chain keys.
const CHAIN_NAMES: Record<string, string> = {
  arc: "Arc",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
};

function explorerTxUrl(txHash: string): string | null {
  const base = process.env.ARC_EXPLORER_URL ?? "https://testnet.arcscan.app";
  return base ? `${base.replace(/\/+$/, "")}/tx/${txHash}` : null;
}

/**
 * Supported source chains this wallet has no active renewal mandate on, at this
 * merchant. Returns undefined if it cannot be determined.
 */
async function countUngrantedChains(
  walletAddress: string,
  merchantId: string
): Promise<number | undefined> {
  try {
    const supported = supportedSourceChains();
    if (supported.length === 0) return 0;

    const grants = await prisma.renewalDelegation.findMany({
      where: {
        status: "active",
        walletAddress: { equals: walletAddress, mode: "insensitive" },
        subscription: { is: { merchantId } },
      },
      select: { chainId: true },
      distinct: ["chainId"],
    });

    const granted = new Set(grants.map((g) => g.chainId));
    return supported.filter((c) => !granted.has(c.chain.id)).length;
  } catch {
    return undefined;
  }
}

/**
 * Emails the receipt for one payment, if it is one a subscriber should get.
 *
 * @param paymentDbId the Payment row's cuid (not the public `pay_…` id).
 */
export async function sendPaymentReceipt(paymentDbId: string): Promise<void> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentDbId },
      include: {
        subscription: {
          include: { plan: true, merchant: { select: { name: true } }, customer: { select: { email: true } } },
        },
      },
    });

    if (!payment) return;
    if (!CHARGE_TYPES.has(payment.type)) return;     // refunds are not receipts
    if (payment.amount <= 0n) return;                // a free trial start is not a payment

    // A first charge is escrowed on-chain the moment checkout completes, so it
    // sits at "pending" until the settlement window closes — up to 24 hours
    // later. The subscriber's money is already committed and they expect a
    // receipt now, so "initial" is receipted while pending. Everything else
    // waits until it has actually succeeded.
    //
    // The pairing that keeps this from sending twice: checkout sends for
    // "initial", and the settlement paths skip "initial" precisely because it
    // was already sent here.
    const receiptable = payment.status === "succeeded" || (payment.status === "pending" && payment.type === "initial");
    if (!receiptable) return;

    const sub = payment.subscription;
    if (!sub) return;

    const to = sub.customer?.email ?? sub.subscriberEmail;
    if (!to) return;

    // How many source chains this subscriber has still not authorized. Arc is
    // excluded on purpose: it renews off the ERC-2612 permit and needs no grant.
    //
    // Counted the same way the checkout grant plan counts it — a grant by this
    // wallet against this merchant carries over, so a returning customer is not
    // invited to re-authorize a chain they already covered on a previous
    // subscription. Best-effort: if the count fails, `undefined` falls through to
    // the invite copy rather than promising renewal cover we cannot confirm.
    const ungrantedChains = await countUngrantedChains(sub.walletAddress, sub.merchantId);

    const amount = (Number(payment.amount) / 1_000_000).toFixed(2);
    const merchantName = sub.merchant.name;
    const chainKey = payment.chain ?? "arc";

    const data: ReceiptEmailData = {
      merchantName,
      planName: sub.plan.name,
      tierName: null,
      amount,
      currency: payment.currency,
      interval: sub.interval ?? sub.plan.interval,
      chargedAt: payment.createdAt,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
      paidFromChain: CHAIN_NAMES[chainKey] ?? chainKey,
      walletAddress: sub.walletAddress,
      txHash: payment.txHash,
      explorerUrl: payment.txHash ? explorerTxUrl(payment.txHash) : null,
      // The period end IS the next charge date while the subscription is live.
      nextRenewalAt: sub.status === "cancelled" ? null : sub.currentPeriodEnd,
      isFirstCharge: payment.type === "initial",
      ungrantedChains,
    };

    // Logged on both sides: a receipt that never arrives is otherwise invisible
    // in the API output, and "did it even try?" is the first question.
    console.log(`[receipt] sending ${payment.paymentId} (${payment.type}/${payment.status}) to ${to}`);

    await sendEmail({
      to,
      subject: `${merchantName} — ${amount} ${payment.currency} ${data.isFirstCharge ? "receipt" : "renewal receipt"}`,
      html: receiptEmailHtml(data),
      text:
        `Paid ${amount} ${payment.currency} to ${merchantName} for ${sub.plan.name}.` +
        (data.nextRenewalAt ? ` Next renewal ${data.nextRenewalAt.toDateString()}.` : "") +
        ` Manage your subscriptions at ${process.env.NEXT_PUBLIC_APP_URL ?? ""}/manage`,
    });

    console.log(`[receipt] sent ${payment.paymentId} to ${to}`);
  } catch (e) {
    // Never propagate: the payment already happened.
    console.warn("[receipt] could not send receipt for", paymentDbId, (e as Error).message);
  }
}
