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
/**
 * How much the grant pins about WHERE money may go.
 *
 *   "none"    (default) — pin nothing. The delegate decides the recipients.
 *   "creator"           — pin the creator's payout wallet only.
 *   "both"              — pin creator and treasury.
 *
 * "none" IS DELIBERATE, AND IT IS A TRADE WORTH STATING.
 *
 * What it gives up: the payee caveat was the one thing stopping whoever holds
 * the delegate key from redeeming a subscriber's period to an address of
 * their choosing. Without it, that key can pay anyone.
 *
 * What it buys, and why it now wins:
 *
 *  - "both" DOES NOT WORK. MetaMask takes `payee` as a list in its types and
 *    forwards it verbatim; with two addresses the permission prompt never
 *    appears. Proven on the sandbox: one payee prompts, two do not. So the
 *    atomic fee split and a pinned payee were never actually compatible.
 *
 *  - A PINNED CREATOR MAKES A PAYOUT WALLET PERMANENT. The address is baked
 *    into every signed permission, so a creator changing theirs silently
 *    kills every existing subscriber's renewal — they would all have to
 *    re-authorize, and would find out at the next billing cycle. Nothing in
 *    the redeem needs the pin: every path reads the creator from the merchant
 *    row at redeem time, which is why unpinning costs nothing there.
 *
 *  - THE KEY IS NO LONGER THE WEAK PART. The delegate is an MSCA owned by an
 *    AWS KMS key: non-exportable, so compromise means compromising IAM rather
 *    than stealing a secret, and the owner rotates while the MSCA address —
 *    the address every grant names — stays put. The caveat was defence
 *    against a private key in an environment variable, which is not what
 *    guards this any more.
 *
 * CUSTODY IS UNAFFECTED, which is the thing to be clear about: the redeem
 * still pays the creator and the treasury directly, in one atomic call, on
 * the payer's own chain. Nothing transits a platform balance. The caveat
 * limited the blast radius of a key compromise; it was never what made this
 * non-custodial.
 */
let pinModeWarned = false;

function payeePinMode(): "none" | "creator" | "both" {
  const raw = process.env.DIRECT_SETTLEMENT_PAYEE_PIN?.trim().toLowerCase();
  if (raw === "creator" || raw === "both" || raw === "none") return raw;

  /**
   * An UNRECOGNISED value is said out loud, not quietly ignored.
   *
   * This takes a mode, not a boolean, and "true" is the value someone reaches
   * for when a variable is named like a switch. Falling through silently
   * would leave a deployment believing it had changed the pin while nothing
   * had — the same shape of fault as a sandbox carrying the live APP_URL, or
   * an .env with the key twice: configuration that looks applied and is not.
   */
  if (raw && !pinModeWarned) {
    pinModeWarned = true;
    console.warn(
      `[settlement] DIRECT_SETTLEMENT_PAYEE_PIN="${raw}" is not a mode and is being IGNORED. ` +
        `Valid values are none, creator, both — and none is the default, so the variable can ` +
        `simply be left unset.`
    );
  }

  // Honoured for the deployments already carrying it.
  if (process.env.DIRECT_SETTLEMENT_SINGLE_PAYEE === "true") return "creator";
  return "none";
}

export function settlementPayees(wallet: Parameters<typeof creatorPayee>[0]):
  | { ok: true; payees: Address[] }
  | { ok: false; reason: string } {
  const creator = creatorPayee(wallet);
  if (!creator.ok) return creator;
  const treasury = treasuryPayee();
  // A merchant whose payout wallet IS the treasury would otherwise pin the
  // same address twice, which is harmless but reads as a bug in the wallet
  // prompt the payer is shown.
  /**
   * The validation above still runs whatever is pinned.
   *
   * creatorPayee() is what proves the merchant HAS a usable payout wallet,
   * and the redeem needs that whether or not the grant names it — so a
   * refusal must still refuse, even when nothing is pinned.
   */
  const mode = payeePinMode();
  if (mode === "none") return { ok: true, payees: [] };
  if (mode === "creator") return { ok: true, payees: [creator.payee] };
  return creator.payee.toLowerCase() === treasury.toLowerCase()
    ? { ok: true, payees: [creator.payee] }
    : { ok: true, payees: [creator.payee, treasury] };
}

/**
 * Whether the platform fee can be taken INSIDE the redeem.
 *
 * It can only go where the grant permits. `payee` maps to an
 * AllowedCalldataEnforcer caveat pinning the recipient bytes of the transfer,
 * so a redeem paying an address the grant does not name is refused by the
 * caveat — and because both transfers ride one redeemDelegations, that
 * refusal reverts the creator's payment with it.
 *
 * THIS WAS A LIVE TRAP, not a hypothetical. settlementPayees under
 * DIRECT_SETTLEMENT_SINGLE_PAYEE warned that "the platform fee is NOT taken
 * in the redeem", and nothing implemented it: direct-charge,
 * delegated-renewal and cctp-activate each computed the fee from
 * platformFeeBps() and passed it on regardless, using the payee list only to
 * check that a payout wallet exists. Pinning one payee would have reverted
 * every renewal carrying a fee — the grant accepted and the charge failed,
 * which is the worse half of each.
 *
 * Takes the creator address rather than the wallet row ON PURPOSE. Asking
 * settlementPayees would re-run the payout-wallet validation, and a wallet
 * that failed it would come back as "fee not takeable" — silently dropping
 * revenue to report an unrelated problem. The only question here is whether
 * the pin admits the treasury, which the mode and two addresses answer.
 */
export function feeTakeableInRedeem(creator: string): boolean {
  const mode = payeePinMode();
  // Nothing pinned: the redeem may pay anyone, the treasury included.
  if (mode === "none") return true;
  // "both" names the treasury explicitly.
  if (mode === "both") return true;
  // "creator" admits the treasury only where the creator IS the treasury.
  return creator.toLowerCase() === treasuryPayee().toLowerCase();
}

/**
 * The fee to use in a redeem, zeroed when the grant would refuse it.
 *
 * Zeroing is reported every time, because a fee silently not charged is
 * revenue quietly lost — an operator has to be able to see that a payee pin
 * is costing them the fee, and decide to change the pin or collect it another
 * way.
 */
export function redeemableFee(creator: string, fee: bigint): bigint {
  if (fee <= 0n) return 0n;
  if (feeTakeableInRedeem(creator)) return fee;
  console.warn(
    `[settlement] the grant pins a payee that is not the treasury ${treasuryPayee()}, so the ` +
      `${fee} micro-USDC platform fee CANNOT be taken in this redeem — paying the creator in ` +
      `full instead. Set DIRECT_SETTLEMENT_PAYEE_PIN=none to take it on-chain, or collect it ` +
      `separately.`
  );
  return 0n;
}
