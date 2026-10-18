/**
 * The merchant's payout wallet, for one mode.
 *
 * A merchant has two: Circle's test and live are separate environments chosen
 * by the API key's prefix, so a wallet created with a TEST_API_KEY does not
 * exist to a LIVE_API_KEY. The chains differ too — Arc testnet against Arc —
 * so even an external address verified in one mode says nothing about the
 * other.
 *
 * The columns are paired on Merchant, the way liveKeyHash pairs testKeyHash.
 * This module is the only place that knows which half to read, so a caller
 * cannot accidentally pay a live charge into a test wallet. That was the
 * actual risk: direct-charge.ts returned the single walletAddress as the
 * payout destination for any charge, and a merchant who onboarded in test and
 * then went live would have had a test wallet as their live payout address.
 *
 * It fails quietly, which is what makes it worth a module. The charge
 * succeeds, the money moves, and it lands somewhere nobody controls.
 */

/** Every wallet column, both modes. Spread into a Prisma `select`. */
export const WALLET_SELECT = {
  walletAddress: true,
  walletType: true,
  circleWalletId: true,
  addressVerifiedAt: true,
  usdcBalance: true,
  balanceUpdatedAt: true,
  liveWalletAddress: true,
  liveWalletType: true,
  liveCircleWalletId: true,
  liveAddressVerifiedAt: true,
  liveUsdcBalance: true,
  liveBalanceUpdatedAt: true,
} as const;

/** What a caller actually wants: one mode's wallet, with no `live` prefix. */
export interface MerchantWallet {
  address: string | null;
  type: string;
  circleWalletId: string | null;
  verifiedAt: Date | null;
  usdcBalance: string;
  balanceUpdatedAt: Date | null;
}

/** The shape WALLET_SELECT returns. Loose on purpose — callers select more. */
type WalletColumns = {
  walletAddress?: string | null;
  walletType?: string;
  circleWalletId?: string | null;
  addressVerifiedAt?: Date | null;
  usdcBalance?: string;
  balanceUpdatedAt?: Date | null;
  liveWalletAddress?: string | null;
  liveWalletType?: string;
  liveCircleWalletId?: string | null;
  liveAddressVerifiedAt?: Date | null;
  liveUsdcBalance?: string;
  liveBalanceUpdatedAt?: Date | null;
};

/**
 * Pick the wallet for a mode.
 *
 * `isTestMode` comes from merchantScope(req) on the API or portalScope(req) in
 * the dashboard — the same value that scopes every other read, so the wallet
 * cannot disagree with the rows it is being paid for.
 */
export function walletFor(m: WalletColumns, isTestMode: boolean): MerchantWallet {
  return isTestMode
    ? {
        address: m.walletAddress ?? null,
        type: m.walletType ?? "external",
        circleWalletId: m.circleWalletId ?? null,
        verifiedAt: m.addressVerifiedAt ?? null,
        usdcBalance: m.usdcBalance ?? "0",
        balanceUpdatedAt: m.balanceUpdatedAt ?? null,
      }
    : {
        address: m.liveWalletAddress ?? null,
        type: m.liveWalletType ?? "external",
        circleWalletId: m.liveCircleWalletId ?? null,
        verifiedAt: m.liveAddressVerifiedAt ?? null,
        usdcBalance: m.liveUsdcBalance ?? "0",
        balanceUpdatedAt: m.liveBalanceUpdatedAt ?? null,
      };
}

/** The fields a write should set, named for the mode it belongs to. */
export interface WalletWrite {
  address?: string | null;
  type?: string;
  circleWalletId?: string | null;
  verifiedAt?: Date | null;
  usdcBalance?: string;
  balanceUpdatedAt?: Date | null;
}

/**
 * Turn a mode-free write into the right half's columns.
 *
 * Returning only the keys that were passed matters: a Prisma update spreads
 * this, and an explicit `undefined` would be a no-op while an explicit `null`
 * clears the column. Building the object key by key keeps "not mentioned" and
 * "set to null" distinct, which is the difference between leaving a wallet
 * alone and unlinking it.
 */
export function walletWrite(isTestMode: boolean, w: WalletWrite): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (testKey: string, liveKey: string, v: unknown) => {
    out[isTestMode ? testKey : liveKey] = v;
  };
  if ("address" in w) put("walletAddress", "liveWalletAddress", w.address);
  if ("type" in w) put("walletType", "liveWalletType", w.type);
  if ("circleWalletId" in w) put("circleWalletId", "liveCircleWalletId", w.circleWalletId);
  if ("verifiedAt" in w) put("addressVerifiedAt", "liveAddressVerifiedAt", w.verifiedAt);
  if ("usdcBalance" in w) put("usdcBalance", "liveUsdcBalance", w.usdcBalance);
  if ("balanceUpdatedAt" in w) put("balanceUpdatedAt", "liveBalanceUpdatedAt", w.balanceUpdatedAt);
  return out;
}
