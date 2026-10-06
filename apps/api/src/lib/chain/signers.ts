// The keys this platform signs with, and how a stored mandate finds the one that
// can redeem it.
//
// Three roles, which today may all resolve to the same private key:
//
//   platform  — the relayer on Arc. It no longer holds any contract role: the
//               SubscriptionManager is retired, so on Arc this key only submits
//               CCTP mints (receiveOnArc) and pays their gas. Every mandate
//               granted before the rail existed still names this address, which
//               is why it must stay resolvable forever.
//   hosted    — the delegate that subscribers coming through Sweep's own checkout
//               grant to. Falls back to the platform key, which is what every
//               mandate granted so far names.
//   external  — the delegate for mandates created through the public rail. Falls
//               back to the hosted delegate until its own key is configured.
//
// Why a registry rather than one getter: a mandate's delegate address is baked
// into the signed ERC-7710 context at grant time and can never be changed. Every
// mandate granted to date names the platform address, so that key must remain
// resolvable forever, no matter what new relayer keys are introduced later. Giving
// the external rail its own key is therefore only possible for NEW mandates, with
// the signer chosen per row from RenewalDelegation.delegateAddress — which is what
// accountForDelegate() below is for.

import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export type RelayerMode = "hosted" | "external";

// privateKeyToAccount does real secp256k1 work, so derive each account once.
const cache = new Map<string, PrivateKeyAccount>();

// A key pasted into a Railway variable straight out of a wallet export often has
// no 0x and sometimes trailing whitespace. viem rejects both, and because keys are
// only derived at the first send, an unprefixed key boots fine and then fails at
// the first redeem — hours later, on a real charge. Normalise, and say which
// variable is wrong when it still cannot be read.
function accountFor(privateKey: string, name: string): PrivateKeyAccount {
  const cached = cache.get(privateKey);
  if (cached) return cached;
  const trimmed = privateKey.trim();
  const hex = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(hex);
  } catch {
    throw new Error(`${name} is not a valid 32-byte private key`);
  }
  cache.set(privateKey, account);
  return account;
}

function platformKey(): string {
  const pk = process.env.PLATFORM_PRIVATE_KEY;
  if (!pk) throw new Error("PLATFORM_PRIVATE_KEY is not set");
  return pk;
}

/// The platform relayer on Arc — submits CCTP mints and pays their gas.
export function getPlatformAccount(): PrivateKeyAccount {
  return accountFor(platformKey(), "PLATFORM_PRIVATE_KEY");
}

/**
 * The delegate a NEW mandate in this mode should be granted to.
 *
 * Both fall through to the platform key when unset, so an unconfigured deployment
 * behaves exactly as it did before this module existed.
 */
export function getRelayerAccount(mode: RelayerMode = "hosted"): PrivateKeyAccount {
  if (mode === "external" && process.env.EXTERNAL_RELAYER_PRIVATE_KEY) {
    return accountFor(process.env.EXTERNAL_RELAYER_PRIVATE_KEY, "EXTERNAL_RELAYER_PRIVATE_KEY");
  }
  const renewal = process.env.RENEWAL_DELEGATE_PRIVATE_KEY;
  return renewal
    ? accountFor(renewal, "RENEWAL_DELEGATE_PRIVATE_KEY")
    : accountFor(platformKey(), "PLATFORM_PRIVATE_KEY");
}

/// The address checkout shows the subscriber, so the grant names the right delegate.
export function getRelayerAddress(mode: RelayerMode = "hosted"): Address {
  return getRelayerAccount(mode).address;
}

/**
 * Where redeemed funds land, and the key that then spends them.
 *
 * Separate from the delegate on purpose. The delegate signs redeemDelegations and
 * nothing else; this account receives the pull, burns it for CCTP and pays the
 * platform fee onward. New grants pin `payee` to this address, so a delegate key
 * on its own can move a subscriber's USDC only into here — an account the holder
 * of that key cannot spend from.
 *
 * Falls back to the hosted relayer when unset, which is the pre-split behaviour:
 * one key doing both jobs. That keeps an unconfigured deployment working rather
 * than failing at the first redemption, but it also means the split is not in
 * effect until SETTLEMENT_PRIVATE_KEY is set — see settlementIsSeparate().
 */
export function getSettlementAccount(): PrivateKeyAccount {
  const key = process.env.SETTLEMENT_PRIVATE_KEY;
  return key ? accountFor(key, "SETTLEMENT_PRIVATE_KEY") : getRelayerAccount("hosted");
}

export function getSettlementAddress(): Address {
  return getSettlementAccount().address;
}

/**
 * True when settlement really is a different key from every delegate.
 *
 * Pinning `payee` to an address the delegate key also controls buys nothing — a
 * thief redeems into it and spends from it with the same key. Callers use this to
 * avoid claiming a protection that is not there.
 */
export function settlementIsSeparate(): boolean {
  const settlement = getSettlementAddress().toLowerCase();
  return !knownDelegates().some((d) => d.toLowerCase() === settlement);
}

/// Every delegate address this deployment currently holds a key for.
export function knownDelegates(): Address[] {
  const seen = new Map<string, Address>();
  for (const account of [getPlatformAccount(), getRelayerAccount("hosted"), getRelayerAccount("external")]) {
    seen.set(account.address.toLowerCase(), account.address);
  }
  return [...seen.values()];
}

/**
 * The key that can redeem a mandate granted to `delegate`.
 *
 * Throws loudly rather than falling back to a default. A mandate whose delegate we
 * hold no key for is unredeemable by anyone — silently signing with a different
 * key would produce a confusing on-chain revert instead of naming the real problem,
 * which is a relayer key that was rotated or removed while grants still pointed at it.
 */
export function accountForDelegate(delegate: Address): PrivateKeyAccount {
  const want = delegate.toLowerCase();
  for (const account of [
    getPlatformAccount(),
    getRelayerAccount("hosted"),
    getRelayerAccount("external"),
    getSettlementAccount(),
  ]) {
    if (account.address.toLowerCase() === want) return account;
  }
  throw new Error(
    `No signing key held for delegate ${delegate}. Mandates granted to it cannot be ` +
      `redeemed until that key is restored. Keys currently held: ${knownDelegates().join(", ")}`
  );
}
