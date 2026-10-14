/**
 * Which account settles a payment, and whether it pays gas in USDC.
 *
 * Settlement runs as a Circle Modular Smart Contract Account — a counterfactual
 * ERC-4337 account owned by the settlement key — rather than as the key's own
 * EOA. Two properties follow, and they are the reason for choosing it over the
 * EIP-7702 alternative that an earlier version of this file described:
 *
 *   ROTATION. The address is derived from the factory and a salt, not from the
 *   owner's key, so the owner can be replaced while the address stays put. A
 *   7702 account's address IS its key's address, so rotating the key moves the
 *   address and strands every grant that pins it.
 *
 *   NO HIJACK. There is no EOA key with inherent authority over a contract
 *   address, so nobody can point it somewhere else by signing an
 *   authorization. A 7702 account can be re-delegated by anyone who can make
 *   its key sign — which is not hypothetical here: three of this deployment's
 *   keys were already delegated to MetaMask's delegator without the codebase
 *   doing it. Upgrades to the MSCA go through its own validation plugin;
 *   measured, a direct upgradeToAndCall reverts RuntimeValidationFailed even
 *   from the account's own address, so Circle cannot change it either.
 *
 * WHAT IT COSTS, AND WHY IT IS AFFORDABLE HERE
 *
 * The MSCA is a NEW address, so grants that pin the settlement EOA as payee
 * cannot be redeemed into it and must keep using the direct path. Fourteen of
 * the twenty-seven live grants do. All twenty-seven are on testnet and can be
 * revoked, and mainnet has none yet, so the overlap costs a testnet cleanup
 * rather than a year of parallel paths.
 *
 * CHAIN COVERAGE
 *
 * Circle's modular wallet is pinned to EntryPoint v0.7 — the SDK defines only
 * ENTRY_POINT_07 and a deployed account returns the v0.7 address. Circle
 * Paymaster exists at v0.7 only on Base and Arbitrum; Optimism's is v0.8 only.
 * So Optimism cannot be gasless with this account and keeps the direct EOA
 * path and its ETH. That is a Circle version gap, not a deployment one.
 *
 * NO CIRCLE API IN THE PATH
 *
 * toCircleSmartAccount works against an ordinary RPC client — verified, same
 * address, same EntryPoint, signing intact. So this needs no Circle client
 * key, no modular transport, and none of the `window` shim their browser-first
 * SDK otherwise forces into a server. The paymaster is addressed as a plain
 * contract, and the bundler is whoever you pay.
 */

import {
  decodeAbiParameters,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { chainKeyForId } from "../gateway/chains";
import { getSettlementAddress } from "./signers";

/**
 * Source chains that settle through the MSCA. All of them.
 *
 * The account's address is the same everywhere — CREATE2 over one factory,
 * one implementation, one owner and one salt, none of which vary by chain —
 * so using it on every chain means every grant pins the SAME payee, and every
 * chain gets the same atomic batch and the same 2D-nonce parallelism.
 *
 * Whether gas is paid in USDC or ETH is a separate question, answered below.
 * Conflating the two is what kept Optimism on the EOA and left settlement
 * split across two addresses for no benefit.
 */
const MSCA_CHAIN_KEYS = new Set(["base", "arbitrum", "optimism"]);

/**
 * Source chains with a Circle Paymaster at EntryPoint v0.7 — the only version
 * the modular wallet speaks.
 *
 * Optimism is absent because its paymaster is v0.8 only. That costs ETH at the
 * MSCA there, not a different settlement address. If Circle ships v0.8 in the
 * SDK, or a v0.7 paymaster on Optimism, adding it here is the whole change.
 */
const V07_PAYMASTER_CHAIN_KEYS = new Set(["base", "arbitrum"]);

/**
 * The settlement MSCA, pinned in config rather than derived.
 *
 * toCircleSmartAccount computes it with an RPC round trip, and the grant path
 * should not make a network call to learn an address that never changes. It is
 * the same on every chain — CREATE2 with one factory and one salt — so a
 * single value covers all of them. Derive it once with
 * scripts/settlement-msca-address.ts.
 */
export function settlementMscaAddress(): Address | null {
  const raw = process.env.SETTLEMENT_MSCA_ADDRESS;
  if (!raw) return null;
  try {
    return getAddress(raw);
  } catch {
    console.warn("[settlement] SETTLEMENT_MSCA_ADDRESS is not an address — ignoring it");
    return null;
  }
}

/**
 * Off unless explicitly switched on.
 *
 * This moves where subscriber money is redeemed to. A deployment that merely
 * has the variables present must not start doing it.
 */
export function settlementMscaEnabled(): boolean {
  return process.env.SETTLEMENT_MSCA_ENABLED === "true";
}

/** True when this chain can settle through the MSCA and its paymaster. */
export function chainSettlesViaMsca(chainId: number): boolean {
  if (!settlementMscaEnabled()) return false;
  if (!settlementMscaAddress()) return false;
  const key = chainKeyForId(chainId);
  return !!key && MSCA_CHAIN_KEYS.has(key);
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
 * Does this grant's calldata rule name `candidate` as the recipient?
 *
 * The payee is not a column — it is encoded into an AllowedCalldataEnforcer's
 * terms as part of the ERC-20 transfer the grant will accept — so the question
 * is answered by decoding, needing no migration or backfill.
 *
 * Substring rather than field extraction, deliberately: the terms hold whole
 * calldata and the recipient's offset depends on the enforcer's layout, so
 * searching for the address avoids hard-coding an offset a future enforcer
 * would silently break. A 20-byte address colliding by accident inside a
 * 68-byte transfer payload is not a realistic worry.
 *
 * A context that will not decode returns false, and the caller treats that as
 * "do not use the new path" — the safe direction.
 */
export function grantPins(context: Hex, candidate: Address): boolean {
  const needle = candidate.toLowerCase().slice(2);
  try {
    const [delegations] = decodeAbiParameters(DELEGATION_ABI_PARAMS, context);
    return delegations.some((d) => d.caveats.some((c) => c.terms.toLowerCase().includes(needle)));
  } catch {
    return false;
  }
}

/**
 * The address a NEW grant on this chain should name as payee.
 *
 * Base and Arbitrum name the MSCA, so the grant redeems straight into the
 * account that can pay its own gas. Optimism, and every chain while the flag
 * is off, names the EOA exactly as before.
 */
export function settlementPayeeFor(chainId: number): Address {
  const msca = settlementMscaAddress();
  return chainSettlesViaMsca(chainId) && msca ? msca : getSettlementAddress();
}

export type SettlementTarget = {
  /** Where to redeem into, and the account that then bridges and pays the fee. */
  address: Address;
  /** True when that account batches through the paymaster and needs no ETH. */
  viaMsca: boolean;
};

/**
 * How to settle an EXISTING grant.
 *
 * The grant decides, not the configuration. One that pins the settlement EOA
 * is redeemed into the EOA whatever the flag says, because
 * AllowedCalldataEnforcer reverts a redemption that goes anywhere else. Only a
 * grant pinning the MSCA — or pinning nothing, which the oldest generation
 * does — may take the batched path.
 */
export function settlementTargetFor(chainId: number, context: Hex): SettlementTarget {
  const eoa = getSettlementAddress();
  const msca = settlementMscaAddress();

  if (!chainSettlesViaMsca(chainId) || !msca) {
    return { address: eoa, viaMsca: false };
  }
  // An explicit pin on the EOA outranks the chain policy — the enforcer wins.
  if (grantPins(context, eoa)) {
    return { address: eoa, viaMsca: false };
  }
  return { address: msca, viaMsca: true };
}

/**
 * Whether this chain's MSCA uses Circle Paymaster, or funds its own gas in ETH.
 *
 * The paymaster is optional; the BUNDLER is not. An MSCA is reachable only
 * through the EntryPoint — its validation plugin answers NotImplemented for a
 * runtime call to execute(), so the owner cannot drive it with an ordinary
 * transaction. Dropping the bundler therefore means dropping the MSCA, and
 * with it the rotation and hijack-immunity it was chosen for. Leaving the
 * MSCA off entirely is the supported way to do that.
 *
 * What this switch buys is one less contract in the path, paid for with ETH
 * balances to keep topped up on every chain. Worth knowing the price of what
 * is being avoided: the surcharge is 10% OF GAS, and gas measured 0.008172
 * USDC on Base Sepolia — so roughly a thousandth of a cent per settlement,
 * against the operational cost of an ETH balance that halts settlement when it
 * runs dry.
 */
export function chainUsesPaymaster(chainId: number): boolean {
  // A global override, for running every chain on ETH without editing code.
  if (process.env.SETTLEMENT_MSCA_SELF_FUNDED === "true") return false;
  const key = chainKeyForId(chainId);
  return !!key && V07_PAYMASTER_CHAIN_KEYS.has(key);
}

/** The inverse, named for the thing that has to be funded. */
export function chainPaysOwnGas(chainId: number): boolean {
  return !chainUsesPaymaster(chainId);
}

/**
 * How much USDC settlement keeps back to pay the paymaster with.
 *
 * Settlement is designed to end each payment at zero, which leaves the
 * paymaster nothing to take. Rather than fund a float by hand, each payment
 * tops the account toward this floor out of the PLATFORM'S OWN FEE — never the
 * merchant's share — and stops once it is reached, so an account already at
 * the floor gives up nothing.
 *
 * Measured gas for one batch on Base Sepolia: 0.027255 USDC including the
 * account's one-off deployment, and well under half that afterwards. The
 * default is comfortably above both, because running dry does not mean a
 * cheaper settlement — it means the operation reverts and the payment does not
 * happen.
 */
export function settlementGasFloor(): bigint {
  const raw = process.env.SETTLEMENT_GAS_FLOOR_USDC;
  if (!raw) return 100_000n; // 0.10 USDC
  try {
    const parsed = BigInt(Math.round(Number(raw) * 1e6));
    return parsed > 0n ? parsed : 100_000n;
  } catch {
    return 100_000n;
  }
}

/**
 * The permit ceiling handed to Circle Paymaster.
 *
 * An allowance, not a charge — only the gas actually used is taken. It must
 * exceed the worst plausible cost or validation fails, and stays well below a
 * real balance so a compromised paymaster could not drain the account.
 */
export function settlementPermitCeiling(): bigint {
  return settlementGasFloor() * 2n;
}

/**
 * Circle Paymaster at EntryPoint v0.7 — the version the modular wallet speaks.
 *
 * One address per network generation. Verified on chain rather than taken from
 * the docs: the mainnet contract holds 0.0382 ETH of v0.7 EntryPoint deposit on
 * Base and 0.0419 on Arbitrum, each configured for that chain's native USDC.
 * Returns null where there is none — Optimism — and the caller funds that
 * chain's operations with ETH instead.
 */
export function circlePaymasterV07(chainId: number): Address | null {
  const key = chainKeyForId(chainId);
  if (!key || !V07_PAYMASTER_CHAIN_KEYS.has(key)) return null;
  const testnet = new Set([84532, 421614]);
  return getAddress(
    testnet.has(chainId)
      ? "0x31BE08D380A21fc740883c0BC434FcFc88740b58"
      : "0x6C973eBe80dCD8660841D4356bf15c32460271C9"
  );
}

/**
 * The bundler to submit through.
 *
 * Required when the MSCA path is on, and deliberately not defaulted to a
 * public endpoint — this is a real third-party dependency someone must choose
 * and pay for, not something to fall back into silently on a money path.
 * Circle's own bundler would serve v0.7, but using it would drag the client
 * key and the browser-only SDK back in for no gain.
 *
 * Per-chain override first, since providers price and rate-limit per chain.
 */
export function bundlerUrlFor(chainId: number): string {
  const url = process.env[`BUNDLER_URL_${chainId}`] ?? process.env.BUNDLER_URL;
  if (!url) {
    throw new Error(
      `settlement MSCA path is on for chain ${chainId} but no bundler is configured — ` +
        `set BUNDLER_URL_${chainId} or BUNDLER_URL`
    );
  }
  return url;
}
