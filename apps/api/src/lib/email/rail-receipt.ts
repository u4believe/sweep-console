// The receipt for one charge on the external rail.
//
// Separate from sendPaymentReceipt because the two have almost nothing in
// common. That one reads a Payment joined to a Subscription and a Plan; a rail
// charge is a Charge joined to a Mandate, and there is no plan, no billing
// period and no schedule Sweep owns. Sharing the function would mean passing
// nulls through a template built to state a next-renewal date.
//
// Like its sibling it NEVER throws: the money already moved, and a mail provider
// having a bad minute must not turn a settled charge into a failed one.

import { prisma } from "../prisma";
import { sendEmail, railChargeReceiptEmailHtml, type RailChargeReceiptData } from "../email";

/// Display names for Charge.chain, which stores the gateway's own chain keys.
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

const usdc = (v: bigint) => (Number(v) / 1_000_000).toFixed(2);

/**
 * Emails the payer their receipt for a settled rail charge.
 *
 * @param chargeDbId the Charge row's cuid (not the public `chg_…` id).
 */
export async function sendRailChargeReceipt(chargeDbId: string): Promise<void> {
  try {
    const charge = await prisma.charge.findUnique({
      where: { id: chargeDbId },
      select: {
        chargeId: true, amount: true, currency: true, status: true, description: true,
        chain: true, txHash: true, createdAt: true,
        merchant: { select: { name: true } },
        mandate: {
          select: { email: true, walletAddress: true, maxAmount: true, interval: true, expiresAt: true },
        },
      },
    });
    if (!charge) return;

    // Only a charge that actually took money. A pending one has not moved funds
    // yet — unlike a hosted first payment, nothing is escrowed here, so there is
    // no reason to receipt ahead of settlement.
    if (charge.status !== "succeeded") return;
    if (charge.amount <= 0n) return;

    // email is optional on a mandate: a developer who never collected one has
    // nowhere for this to go. Worth a line in the log, because a merchant
    // wondering why their payers get no receipt will look here first.
    const to = charge.mandate.email;
    if (!to) {
      console.log(`[rail-receipt] ${charge.chargeId}: mandate has no email, nothing sent`);
      return;
    }

    const amount = usdc(charge.amount);
    const chainKey = charge.chain ?? "arc";
    const data: RailChargeReceiptData = {
      merchantName: charge.merchant.name,
      description: charge.description,
      amount,
      currency: charge.currency,
      chargedAt: charge.createdAt,
      paidFromChain: CHAIN_NAMES[chainKey] ?? chainKey,
      walletAddress: charge.mandate.walletAddress,
      txHash: charge.txHash,
      explorerUrl: charge.txHash ? explorerTxUrl(charge.txHash) : null,
      ceiling: usdc(charge.mandate.maxAmount),
      interval: charge.mandate.interval,
      authorizationExpiresAt: charge.mandate.expiresAt,
    };

    console.log(`[rail-receipt] sending ${charge.chargeId} to ${to}`);

    await sendEmail({
      to,
      subject: `${charge.merchant.name} — ${amount} ${charge.currency} charged`,
      html: railChargeReceiptEmailHtml(data),
      text:
        `${charge.merchant.name} charged ${amount} ${charge.currency} from your wallet` +
        (charge.description ? ` for ${charge.description}` : "") +
        `, settled on Arc${charge.txHash ? ` (tx ${charge.txHash})` : ""}. ` +
        `You authorized up to ${data.ceiling} ${charge.currency} per ` +
        `${{ daily: "day", weekly: "week", monthly: "month", yearly: "year" }[charge.mandate.interval] ?? charge.mandate.interval}. ` +
        `To stop future charges, revoke the permission in your wallet.`,
    });

    console.log(`[rail-receipt] sent ${charge.chargeId} to ${to}`);
  } catch (e) {
    // Never propagate: the charge already settled on chain.
    console.warn("[rail-receipt] could not send receipt for", chargeDbId, (e as Error).message);
  }
}
