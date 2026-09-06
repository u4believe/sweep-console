// The keys this platform signs with, and how a stored mandate finds the one that
// can redeem it.
//
// Three roles, which today may all resolve to the same private key:
//
//   platform  — the SubscriptionManager arbiter on Arc (settle, renew, refund,
//               cancel, subscribeWithPermit). Holds a privileged on-chain role.
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

function accountFor(privateKey: string): PrivateKeyAccount {
  const cached = cache.get(privateKey);
  if (cached) return cached;
  const account = privateKeyToAccount(privateKey as Hex);
  cache.set(privateKey, account);
  return account;
}

function platformKey(): string {
  const pk = process.env.PLATFORM_PRIVATE_KEY;
  if (!pk) throw new Error("PLATFORM_PRIVATE_KEY is not set");
  return pk;
}

/// The arbiter that calls the SubscriptionManager on Arc.
export function getPlatformAccount(): PrivateKeyAccount {
  return accountFor(platformKey());
}

/**
 * The delegate a NEW mandate in this mode should be granted to.
 *
 * Both fall through to the platform key when unset, so an unconfigured deployment
 * behaves exactly as it did before this module existed.
 */
export function getRelayerAccount(mode: RelayerMode = "hosted"): PrivateKeyAccount {
  if (mode === "external" && process.env.EXTERNAL_RELAYER_PRIVATE_KEY) {
    return accountFor(process.env.EXTERNAL_RELAYER_PRIVATE_KEY);
  }
  return accountFor(process.env.RENEWAL_DELEGATE_PRIVATE_KEY ?? platformKey());
}

/// The address checkout shows the subscriber, so the grant names the right delegate.
export function getRelayerAddress(mode: RelayerMode = "hosted"): Address {
  return getRelayerAccount(mode).address;
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
  for (const account of [getPlatformAccount(), getRelayerAccount("hosted"), getRelayerAccount("external")]) {
    if (account.address.toLowerCase() === want) return account;
  }
  throw new Error(
    `No signing key held for delegate ${delegate}. Mandates granted to it cannot be ` +
      `redeemed until that key is restored. Keys currently held: ${knownDelegates().join(", ")}`
  );
}
