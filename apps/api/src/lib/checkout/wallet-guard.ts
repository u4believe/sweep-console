// One wallet, one customer's subscriptions — per merchant.
//
// A wallet is allowed to pay several merchants (nothing here is global, and the
// allowance floor in ../subscriptions/allowance.ts sizes for that). What it may
// NOT do is carry live subscriptions for two different customers of the SAME
// merchant, because those two subscriptions then share one USDC balance and one
// allowance pool with no way to tell them apart: they drain each other, and
// whichever renewal runs second reverts. Worse, the merchant sees two accounts
// backed by one payment source it cannot separately dun or cancel.
//
// So the rule is: a wallet with a chargeable subscription at this merchant is
// spoken for. Anyone else must connect a different wallet. Deliberately NOT
// blocked is the same customer paying again from the same wallet — that is the
// upgrade path, and checkout completion retires the prior subscription, leaving
// the wallet with exactly one.

import { prisma } from "../prisma";
import { maskEmail, normalizeEmail } from "./identity";

/// Statuses that still bill, and so still hold the wallet.
const CHARGEABLE = ["active", "trialing", "past_due"];

export interface WalletConflict {
  /// The subscription already on this wallet at this merchant.
  subscriptionId: string;
  /// Masked — the blocked party must never learn who holds the wallet.
  ownerEmailMasked: string;
}

/// Identity of the party attempting to pay, as far as the guard needs it. Either
/// field alone is enough to recognise their own subscriptions; a completing
/// checkout has both.
export interface PayingIdentity {
  customerDbId?: string | null;
  email?: string | null;
}

/// Is this wallet already carrying a live subscription at this merchant for
/// SOMEONE ELSE? Returns the blocking subscription, or null when the wallet is
/// free (or when the only subscription on it is the caller's own).
export async function findWalletConflict(params: {
  merchantId: string;
  walletAddress: string;
  identity: PayingIdentity;
}): Promise<WalletConflict | null> {
  const { merchantId, identity } = params;
  const walletAddress = params.walletAddress.toLowerCase();

  // Everything belonging to the payer, matched on either anchor: the stable
  // customer row, or the email (which also covers legacy subs predating it).
  const mine: object[] = [];
  if (identity.customerDbId) mine.push({ customerId: identity.customerDbId });
  if (identity.email) mine.push({ subscriberEmail: normalizeEmail(identity.email) });

  const conflict = await prisma.subscription.findFirst({
    where: {
      merchantId,
      walletAddress,
      status: { in: CHARGEABLE },
      ...(mine.length > 0 ? { NOT: { OR: mine } } : {}),
    },
    select: {
      subscriptionId: true,
      subscriberEmail: true,
      customer: { select: { email: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!conflict) return null;

  const owner = conflict.customer?.email ?? conflict.subscriberEmail;
  return {
    subscriptionId: conflict.subscriptionId,
    ownerEmailMasked: owner ? maskEmail(owner) : "another account",
  };
}

/// The message the subscriber sees. Deliberately says what to do next — the only
/// way forward is a different wallet, and saying so up front beats a bare refusal.
export function walletConflictMessage(conflict: WalletConflict, merchantName?: string): string {
  return (
    `This wallet already has an active subscription with ${merchantName ?? "this merchant"} ` +
    `under ${conflict.ownerEmailMasked}. Connect a different wallet to subscribe.`
  );
}

/// Read-only mirror of resolveCheckoutCustomer's precedence, for pre-flight checks
/// that must not create anything: a proven email identifies the payer, otherwise
/// the wallet's existing link does. Returns an empty identity when neither holds,
/// which makes the guard treat ANY live subscription on the wallet as a conflict —
/// the safe default for an unidentified payer.
export async function identifyPayer(params: {
  merchantId: string;
  walletAddress: string;
  email?: string | null;
  emailProven: boolean;
}): Promise<PayingIdentity> {
  const { merchantId, email, emailProven } = params;

  if (emailProven && email) {
    const normalized = normalizeEmail(email);
    const customer = await prisma.customer.findUnique({
      where: { merchantId_email: { merchantId, email: normalized } },
      select: { id: true },
    });
    return { customerDbId: customer?.id ?? null, email: normalized };
  }

  const link = await prisma.customerWallet.findUnique({
    where: { merchantId_address: { merchantId, address: params.walletAddress.toLowerCase() } },
    select: { customerId: true, customer: { select: { email: true } } },
  });
  if (!link) return {};
  return { customerDbId: link.customerId, email: link.customer.email };
}
