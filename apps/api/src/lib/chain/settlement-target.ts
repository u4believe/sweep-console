/**
 * Whether settlement on a given chain can pay its gas in USDC.
 *
 * This file used to be much longer. It carried machinery for deciding which of
 * two ADDRESSES a grant could be redeemed into, because the first plan put
 * settlement behind a Circle modular wallet — a counterfactual account at a
 * new address, which the 14 of 27 live grants that pin the settlement EOA as
 * payee could never be redeemed into. All of that is gone, because EIP-7702
 * makes the question disappear.
 *
 * A 7702 account's address IS the EOA's address. Delegating the existing
 * settlement key leaves 0x1e1B4CD8… exactly where it was; every grant that
 * pins it keeps working, on every chain, immediately. Nothing has to expire
 * and nothing has to be re-signed. So there is no target to choose and no
 * payee caveat to decode — only the question below.
 *
 * WHAT IS LEFT TO DECIDE
 *
 * Circle Paymaster is deployed at one address per network generation and
 * covers all three source chains at EntryPoint v0.8: measured on testnet,
 * 1.6708 ETH of deposit on Base Sepolia, 1.6782 on OP Sepolia and 2.4599 on
 * Arbitrum Sepolia, each holding that chain's own USDC; on mainnet
 * 0x0578cFB2… is deployed and unpaused on Base, Arbitrum and Optimism alike.
 *
 * So the chain list is all three, and the flag is the only real gate. The
 * per-chain shape is kept anyway because the deployment is Circle's to change,
 * and a chain dropping off should be one line here rather than a hunt.
 *
 * WHAT THIS DOES NOT BUY
 *
 * Rotation. Simple7702Account has no owner storage — no owner(), getOwner() or
 * owners() — and validates against the account's own key. More fundamentally,
 * an EOA that has delegated can still sign a fresh authorization pointing
 * somewhere else, so the original key keeps ultimate authority over the
 * address whatever implementation sits behind it. A leaked settlement key is
 * not answered by rotating anything; it is answered by the key never being
 * extractable, which is a KMS question, not a 7702 one.
 */

import { getAddress, type Address } from "viem";
import { chainKeyForId } from "../gateway/chains";
import { getSettlementAddress } from "./signers";

/**
 * Source chains where Circle Paymaster is deployed at EntryPoint v0.8.
 *
 * Keyed by chainKey so testnet and mainnet share a row. All three are listed
 * because all three are covered — unlike the v0.7 paymaster, which reaches
 * only Base and Arbitrum and is why the Circle modular wallet could not serve
 * Optimism at all.
 */
const PAYMASTER_CHAIN_KEYS = new Set(["base", "arbitrum", "optimism"]);

/**
 * Off unless explicitly switched on.
 *
 * This changes how settlement transacts — one batched UserOperation through a
 * third-party bundler instead of two direct transactions — on a live money
 * path. A deployment that merely has the variables present should not start
 * doing it.
 */
export function settlementUserOpEnabled(): boolean {
  return process.env.SETTLEMENT_USEROP_ENABLED === "true";
}

/** True when settlement on this chain should batch through the paymaster. */
export function chainSettlesViaUserOp(chainId: number): boolean {
  if (!settlementUserOpEnabled()) return false;
  const key = chainKeyForId(chainId);
  return !!key && PAYMASTER_CHAIN_KEYS.has(key);
}

/**
 * Where redeemed funds land. Unchanged by any of this, and that is the point.
 *
 * Kept as a named function rather than letting call sites reach for
 * getSettlementAddress() directly, so that the one place this could ever stop
 * being true is this one.
 */
export function settlementPayeeFor(_chainId: number): Address {
  return getSettlementAddress();
}

/**
 * How much USDC settlement keeps back to pay the paymaster with.
 *
 * Settlement is designed to end each payment at zero, which leaves the
 * paymaster nothing to take. Rather than fund a float by hand, each payment
 * tops the account up towards this floor out of the PLATFORM'S OWN FEE — never
 * out of the merchant's share — and stops once the floor is reached. An
 * account already at the floor contributes nothing and the platform receives
 * its fee in full.
 *
 * Measured gas for one settlement batch: 0.006384 USDC on Base Sepolia,
 * 0.002703 on OP Sepolia, 0.016562 on Arbitrum Sepolia. The default floor is
 * several times the worst of those, because running dry does not mean a
 * cheaper settlement — it means the UserOperation reverts and the payment does
 * not happen.
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
 * An allowance, not a charge — the paymaster takes only the gas it actually
 * used. It has to exceed the worst plausible gas cost or validation fails, and
 * it is capped well below any real balance so a compromised paymaster could
 * not drain the account.
 */
export function settlementPermitCeiling(): bigint {
  return settlementGasFloor() * 2n;
}

/**
 * The implementation a 7702 settlement account delegates to.
 *
 * viem hardcodes this inside toSimple7702SmartAccount and does not export it,
 * so it is mirrored here rather than read — the delegation monitor needs to
 * know the expected pointer without constructing an account, and an env var
 * for a value that is really a property of the library would just be a way to
 * get it wrong.
 *
 * settleViaUserOp asserts the account viem builds actually points here, so a
 * viem upgrade that moves it fails loudly at settlement rather than quietly
 * teaching the monitor to expect the wrong address.
 */
export const SIMPLE_7702_IMPLEMENTATION: Address = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";

/** Circle Paymaster v0.8, one address per network generation. */
export function circlePaymasterV08(chainId: number): Address {
  const testnet = new Set([84532, 11155420, 421614]);
  return getAddress(
    testnet.has(chainId)
      ? "0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966"
      : "0x0578cFB241215b77442a541325d6A4E6dFE700Ec"
  );
}

/**
 * The bundler to submit through.
 *
 * Required when the UserOp path is on, and deliberately not defaulted to a
 * public endpoint: Circle's own bundler serves only EntryPoint v0.7, so this
 * is a real third-party dependency that someone has to choose and pay for
 * rather than something to fall back into silently on a money path.
 *
 * Per-chain override first, since providers price and rate-limit per chain.
 */
export function bundlerUrlFor(chainId: number): string {
  const specific = process.env[`BUNDLER_URL_${chainId}`];
  const general = process.env.BUNDLER_URL;
  const url = specific ?? general;
  if (!url) {
    throw new Error(
      `settlement UserOp path is on for chain ${chainId} but no bundler is configured — ` +
        `set BUNDLER_URL_${chainId} or BUNDLER_URL`
    );
  }
  return url;
}
