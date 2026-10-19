/**
 * The smallest amount worth moving on mainnet.
 *
 * Every charge costs the platform gas no matter how small it is, and the
 * platform's only revenue is PLATFORM_FEE_BPS of the amount. Below some price
 * the fee stops covering the cost and each renewal is subsidised, forever,
 * because a subscription renews on its own.
 *
 * Measured settlement gas on testnet: Base 0.006384 USDC, Optimism 0.002703,
 * Arbitrum 0.016562. Against a 2% fee that puts break-even near a dollar on
 * Arbitrum, the most expensive of the three — $1 earns 2 cents against 1.66
 * cents of gas. Base and Optimism clear it comfortably. Mainnet should be
 * cheaper still: CCTP V2 charges 0.325 bps there against 1.3 on the sandbox,
 * and L2 gas is usually lower than a testnet's.
 *
 * So the default is a dollar and the variable exists because those numbers
 * move. Lower it when real settlements say the margin is wider; do not raise
 * it without checking what it does to existing plans, which are not
 * retroactively blocked.
 *
 * TESTNET IS EXEMPT. Nothing there costs real gas, and a floor would stop a
 * developer trying a 1-cent plan to see how the product behaves — which is
 * what testnet is for.
 */

import { isMainnet } from "./gateway/chains";

/// USDC has 6 decimals, so amounts are micro-units throughout.
const MICROS_PER_USDC = 1_000_000n;

/**
 * The floor in micro-USDC, or null where none applies.
 *
 * Null rather than 0n so a caller cannot accidentally compare against a floor
 * that is not in force and conclude every amount passes it.
 */
export function chargeFloorMicros(): bigint | null {
  if (!isMainnet()) return null;
  const raw = process.env.MIN_CHARGE_USDC ?? "1.00";
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // A malformed value must not silently disable the floor — that is the one
    // failure mode worth being loud about, since it reads as "working".
    throw new Error(`MIN_CHARGE_USDC is not a number: ${JSON.stringify(raw)}`);
  }
  return BigInt(Math.round(parsed * Number(MICROS_PER_USDC)));
}

/** Human form of the floor, for a message. "1.00" from 1_000_000n. */
export function formatFloor(micros: bigint): string {
  return (Number(micros) / Number(MICROS_PER_USDC)).toFixed(2);
}

/**
 * Whether `amount` (micro-USDC) is under the floor.
 *
 * Returns false when no floor applies, so a caller reads as "is this refused"
 * rather than having to know whether a floor exists.
 */
export function belowChargeFloor(amount: number | bigint): boolean {
  const floor = chargeFloorMicros();
  if (floor === null) return false;
  return BigInt(amount) < floor;
}

/**
 * The refusal, naming the floor and the amount.
 *
 * `what` is the noun the caller is refusing — "plan", "tier", "charge" — so
 * the message reads correctly wherever it appears without each site writing
 * its own and drifting.
 */
export function chargeFloorMessage(what: string, amount: number | bigint): string {
  const floor = chargeFloorMicros();
  const f = floor === null ? "0.00" : formatFloor(floor);
  const a = (Number(amount) / Number(MICROS_PER_USDC)).toFixed(2);
  return (
    `A ${what} must be at least ${f} USDC on mainnet — this one is ${a}. ` +
    `Below that the network fee for collecting it exceeds what the payment is worth.`
  );
}
