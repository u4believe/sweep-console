/**
 * Wallet-to-wallet settlement: the creator's own wallet is the payee.
 *
 * WHAT CHANGES. Today a grant pins the platform's settlement address, and the
 * code that does it already says why that is worth little:
 *
 *   Pinning it to an address the delegate already controls constrains
 *   nothing — a thief redeems into it and spends from it with the same key —
 *   and would leave a caveat in the signed context implying a protection
 *   that is not there.
 *
 * Pinning the CREATOR's wallet is the first time that caveat protects the
 * payer. The redemption can then only move USDC to the merchant the payer
 * chose to subscribe to, enforced by AllowedCalldataEnforcer rather than by
 * our good behaviour, and the platform never receives the funds at all.
 *
 * WHY A FLAG. Pinning a payee the settlement path does not pay produces a
 * revert on every redemption — AllowedCalldataEnforcer:invalid-calldata, the
 * exact failure that took the rail down on 2026-10-28. The payee and the
 * redeem must move together, so both read this one switch and a half-applied
 * migration is impossible.
 *
 * ONE ADDRESS ACROSS CHAINS. A grant carries one payee for every chain the
 * payer signs on, so the creator's address has to be valid on all of them.
 * An external EOA is: one address works on every EVM chain. A Circle wallet
 * is too — Circle issues a single EVM address per user and registers it per
 * chain, which is why registering the extra chains is a configuration change
 * rather than a new address.
 */
import type { Address } from "viem";

/**
 * The platform's fee destination. Pinned into the permission beside the
 * creator, so a redemption can reach it and nothing else can.
 */
export function treasuryPayee(): Address {
  const t = process.env.PLATFORM_TREASURY_ADDRESS;
  if (!t) throw new Error("PLATFORM_TREASURY_ADDRESS is not set");
  if (!/^0x[a-fA-F0-9]{40}$/.test(t)) {
    throw new Error(`PLATFORM_TREASURY_ADDRESS is not an EVM address: ${t}`);
  }
  return t as Address;
}

/**
 * WHAT THE FLAG COVERS TODAY: THE RAIL ONLY.
 *
 * A grant pins its payees when it is signed; a redeem pays whoever the grant
 * pinned. Those two must agree, or every redemption reverts with
 * AllowedCalldataEnforcer:invalid-calldata. They are in different files, so
 * the pairing is what matters, not the file:
 *
 *   rail    routes/authorize.ts  +  billing/direct-charge.ts     flag-aware
 *   hosted  routes/delegation.ts, routes/customer-portal.ts
 *           +  billing/delegated-renewal.ts                      legacy only
 *
 * Each path is internally consistent, so turning the flag on moves the rail
 * and leaves hosted bridging through the relayer exactly as before. That is
 * deliberate staging, not an oversight — but it means the platform is still
 * custodial for hosted subscriptions, and the non-custodial claim cannot be
 * made until that half is migrated too.
 *
 * scripts/check-direct-settlement.ts holds the pairing to this list.
 */

/** True once this deployment settles payer-to-creator with no relayer hop. */
export function directSettlementEnabled(): boolean {
  return process.env.DIRECT_SETTLEMENT_ENABLED === "true";
}

/**
 * The payee to pin, or a reason it cannot be pinned.
 *
 * A grant pinned to a missing address is unredeemable, so this refuses rather
 * than returning undefined: under direct settlement a merchant with no
 * verified payout wallet cannot take subscriptions at all, and the honest
 * place to say so is when the mandate is created, not when the first charge
 * reverts months later.
 */
export function creatorPayee(wallet: {
  address: string | null;
  verifiedAt: Date | null;
  type: string;
}): { ok: true; payee: Address } | { ok: false; reason: string } {
  if (!wallet.address) {
    return {
      ok: false,
      reason:
        "This merchant has no payout wallet set for this mode. Under direct settlement the " +
        "payer's permission names the payout wallet, so one must exist before a mandate can " +
        "be authorized.",
    };
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet.address)) {
    return { ok: false, reason: `Payout wallet ${wallet.address} is not an EVM address.` };
  }
  /**
   * An unverified EXTERNAL address is refused. A Circle wallet needs no proof
   * of control because this platform created it; an address a merchant typed
   * has only their word behind it, and a typo pinned into every subscriber's
   * signed permission cannot be corrected without re-collecting consent from
   * all of them.
   */
  if (wallet.type !== "circle" && !wallet.verifiedAt) {
    return {
      ok: false,
      reason:
        "This merchant's payout address has not been verified. It is pinned into every " +
        "subscriber's signed permission and cannot be changed without re-authorizing them, " +
        "so it must be proven first.",
    };
  }
  return { ok: true, payee: wallet.address as Address };
}

/**
 * Every address a redemption of this grant may pay, and no others.
 *
 * TWO, NOT ONE, and ERC-7715 allows that: `payee` is a list. The creator
 * takes their share and the treasury takes the platform fee, so both halves
 * of a settlement come out of the same permission and can ride one
 * redeemDelegations call — which is what makes them atomic. A single pinned
 * payee would have forced the fee into a second, unpinned grant, or out of
 * the creator's pocket.
 *
 * What the payer is agreeing to is therefore exactly legible in their wallet:
 * this permission can pay these two addresses, up to this much per period,
 * and nothing else. That is a stronger statement than today's grant makes,
 * not a weaker one.
 */
export function settlementPayees(wallet: Parameters<typeof creatorPayee>[0]):
  | { ok: true; payees: Address[] }
  | { ok: false; reason: string } {
  const creator = creatorPayee(wallet);
  if (!creator.ok) return creator;
  const treasury = treasuryPayee();
  // A merchant whose payout wallet IS the treasury would otherwise pin the
  // same address twice, which is harmless but reads as a bug in the wallet
  // prompt the payer is shown.
  return creator.payee.toLowerCase() === treasury.toLowerCase()
    ? { ok: true, payees: [creator.payee] }
    : { ok: true, payees: [creator.payee, treasury] };
}
