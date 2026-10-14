/**
 * Which account settles a given grant, and whether it can pay gas in USDC.
 *
 * Settlement has always been one address: SETTLEMENT_PRIVATE_KEY, an EOA that
 * needs native ETH on every source chain. Circle Paymaster can remove that, but
 * only on the chains where it is deployed, and only for grants whose payee rule
 * does not say otherwise. This module is where both questions are answered, so
 * the ten call sites that redeem, bridge or pay a fee do not each carry their
 * own copy of the policy.
 *
 * TWO INDEPENDENT CONSTRAINTS, AND THEY ARE OFTEN CONFUSED
 *
 *   1. The ENTRYPOINT VERSION — not, as an earlier version of this comment
 *      claimed, whether Circle Paymaster reaches Optimism. It does. Circle
 *      Paymaster v0.8 (0x0578cFB2…) is deployed, funded and unpaused on OP
 *      Mainnet, Base Mainnet and Arbitrum One alike, each holding that chain's
 *      native USDC.
 *
 *      What does not reach Optimism is CIRCLE'S MODULAR WALLET, which is
 *      hardcoded to EntryPoint v0.7 — the SDK defines only ENTRY_POINT_07 and
 *      mentions 0.8 nowhere, and a deployed account agrees: ENTRY_POINT()
 *      returns 0x0000000071727De22E5E9d8BAf0edAc6f37da032. A v0.7 account
 *      cannot submit through the v0.8 EntryPoint.
 *
 *      Base and Arbitrum also have a v0.7 paymaster (0x6C973eBe… on mainnet),
 *      so the pairing works there. Optimism's paymaster is v0.8 only, so
 *      Circle's own wallet cannot use Circle's own paymaster on it. Optimism
 *      keeps the EOA because of that version gap, and a v0.8-capable account
 *      would close it.
 *
 *   2. The GRANT. A grant signed with a payee rule pins the recipient into a
 *      caveat, and redeeming anywhere else reverts with
 *      AllowedCalldataEnforcer:invalid-calldata. 14 of the 27 grants live today
 *      pin the settlement EOA. Those cannot be redeemed into a smart account
 *      however the chain is configured — they are fixed until they expire, and
 *      the newest was signed 2026-10-11 against a one-year lifetime.
 *
 * So the honest shape of "Base and Arbitrum go gasless" is: new grants on those
 * two chains go gasless from the day the flag is set, and the existing ones
 * drain away over the following year. ETH is still required on all three chains
 * during that window, in a declining amount. There is no way to shorten it
 * without asking subscribers to re-sign.
 */

import { decodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import { chainKeyForId } from "../gateway/chains";
import { getSettlementAddress } from "./signers";

/**
 * Chains where Circle Paymaster exists.
 *
 * Keyed by chainKey rather than chainId so testnet and mainnet share a row —
 * the deployment story is the same on Base Sepolia as on Base, and a list of
 * raw ids would need editing twice.
 *
 * Optimism's absence is the whole point of the file. If Circle deploys there,
 * adding "optimism" here is the entire change.
 */
const PAYMASTER_CHAIN_KEYS = new Set(["base", "arbitrum"]);

/**
 * The smart account that settles when the paymaster path is on.
 *
 * Read from config, not derived. toCircleSmartAccount() computes the address
 * with a live call to Circle's API, and putting that in the grant path would
 * make every checkout depend on Circle being up to decide an address that never
 * changes. It is deterministic from the owner, so it is computed once and set
 * here; only the actual UserOperation send needs Circle reachable.
 */
function settlementSmartAddress(): Address | null {
  const raw = process.env.SETTLEMENT_SMART_ADDRESS;
  if (!raw) return null;
  try {
    return getAddress(raw);
  } catch {
    console.warn("[settlement] SETTLEMENT_SMART_ADDRESS is not an address — ignoring it");
    return null;
  }
}

/**
 * Off unless explicitly switched on.
 *
 * This moves where subscriber money lands. A deployment that merely happens to
 * have the variables set should not start doing it.
 */
function paymasterEnabled(): boolean {
  return process.env.SETTLEMENT_PAYMASTER_ENABLED === "true";
}

/** True when this chain could settle through the paymaster, grant aside. */
export function chainSupportsPaymaster(chainId: number): boolean {
  if (!paymasterEnabled()) return false;
  if (!settlementSmartAddress()) return false;
  const key = chainKeyForId(chainId);
  return !!key && PAYMASTER_CHAIN_KEYS.has(key);
}

const DELEGATION_ABI_PARAMS = [
  {
    type: "tuple[]",
    components: [
      { name: "delegate", type: "address" },
      { name: "delegator", type: "address" },
      { name: "authority", type: "bytes32" },
      {
        name: "caveats",
        type: "tuple[]",
        components: [
          { name: "enforcer", type: "address" },
          { name: "terms", type: "bytes" },
          { name: "args", type: "bytes" },
        ],
      },
      { name: "salt", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

/**
 * Does this grant's calldata rule pin `candidate` as the recipient?
 *
 * The payee is not a column — it lives inside the context blob, encoded into an
 * AllowedCalldataEnforcer's terms as part of the ERC-20 transfer calldata the
 * grant will accept. So the question is answered by decoding, which costs
 * nothing and needs no migration or backfill.
 *
 * Substring rather than field extraction, deliberately. The terms hold whole
 * calldata and the offset of the recipient within it depends on the enforcer's
 * own layout; searching for the address avoids hard-coding an offset that a
 * future enforcer would silently break. A 20-byte address appearing by accident
 * in a 68-byte transfer payload is not a realistic collision.
 *
 * Returns false for a context that will not decode. A grant we cannot read is
 * not a grant we should claim anything about — the caller treats that as "do
 * not use the new path", which is the safe direction.
 */
export function grantPins(context: Hex, candidate: Address): boolean {
  const needle = candidate.toLowerCase().slice(2);
  try {
    const [delegations] = decodeAbiParameters(DELEGATION_ABI_PARAMS, context);
    return delegations.some((d) =>
      d.caveats.some((c) => c.terms.toLowerCase().includes(needle))
    );
  } catch {
    return false;
  }
}

/**
 * The address a NEW grant on this chain should name as payee.
 *
 * Base and Arbitrum name the smart account, so the grant is redeemable straight
 * into the thing that can pay its own gas. Optimism, and every chain while the
 * flag is off, names the EOA exactly as before.
 */
export function settlementPayeeFor(chainId: number): Address {
  const smart = settlementSmartAddress();
  return chainSupportsPaymaster(chainId) && smart ? smart : getSettlementAddress();
}

export type SettlementTarget = {
  /** Where to redeem into, and the account that then bridges and pays the fee. */
  address: Address;
  /** True when that account settles through Circle Paymaster and needs no ETH. */
  viaPaymaster: boolean;
};

/**
 * How to settle an EXISTING grant.
 *
 * The grant decides, not the configuration. A grant that pins the EOA is
 * redeemed into the EOA on any chain, flag or no flag, because the enforcer
 * will revert otherwise. Only a grant that pins the smart account — or pins
 * nothing at all — may take the gasless path, and then only where Circle
 * Paymaster is deployed.
 *
 * The "pins nothing" case is the oldest generation of grants, signed before the
 * settlement split. They accept any recipient, so they are free to use whichever
 * path the chain supports.
 */
export function settlementTargetFor(chainId: number, context: Hex): SettlementTarget {
  const eoa = getSettlementAddress();
  const smart = settlementSmartAddress();

  if (!chainSupportsPaymaster(chainId) || !smart) {
    return { address: eoa, viaPaymaster: false };
  }
  // An explicit pin on the EOA outranks the chain policy — the enforcer wins.
  if (grantPins(context, eoa)) {
    return { address: eoa, viaPaymaster: false };
  }
  return { address: smart, viaPaymaster: true };
}
