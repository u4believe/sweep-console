/**
 * The smallest amount worth moving on mainnet.
 *
 * Every charge costs the platform gas no matter how small it is, and the
 * platform's only revenue is PLATFORM_FEE_BPS of the amount. Below some price
 * the fee stops covering the cost and each renewal is subsidised, forever,
 * because a subscription renews on its own.
 *
 * MEASURED ON MAINNET, which the earlier estimate was not. The figure here
 * used to come from testnet settlement gas and reasoned that mainnet "should
 * be cheaper still". It is not, on Arbitrum. Three complete payments, every
 * leg, at ETH $2342:
 *
 *             pull (ETH)    settle (USDC)   mint on Arc   TOTAL
 *   base      $0.004859     0.007153        0.003607      $0.015619
 *   arbitrum  $0.016378     0.023334        0.003607      $0.043319
 *
 * A renewal is three transactions on two chains, not one: the pull is paid in
 * ETH by the delegate, the settle through Circle Paymaster in USDC, and the
 * mint in USDC on Arc. Counting only the settle — which the testnet estimate
 * did — understates the cost by roughly half.
 *
 * Against a 2% fee that puts break-even at $0.78 on Base and $2.17 on
 * ARBITRUM, and the floor has to clear the most expensive chain because the
 * payer picks it, not the creator.
 *
 * $2.00 IS DELIBERATELY JUST UNDER THAT. At $2 Arbitrum earns 0.0400 against
 * 0.0433 of gas — about a third of a cent lost per renewal, forever, since a
 * subscription renews itself. It was chosen as a round number a creator can
 * reason about. $2.50 would be the first round figure that clears every
 * chain; raise MIN_CHARGE_USDC to it if the subsidy on cheap Arbitrum plans
 * stops being worth the simpler number.
 *
 * Gas is near-FIXED per payment, so the percentage is set by the price: the
 * same $0.0433 is 4.3% of a $1 plan and 0.4% of a $10 one. That is the whole
 * argument for a floor.
 *
 * Do not raise it without checking what it does to existing plans, which are
 * not retroactively blocked.
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
  const raw = process.env.MIN_CHARGE_USDC ?? "2.00";
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

/** The error code this refusal carries. Documented in rail/charges.md. */
export const CHARGE_FLOOR_CODE = "amount_below_minimum";

/**
 * The whole refusal: status, code, message and the field it is about.
 *
 * A code of its own rather than the generic `validation_error`, because this
 * is a business rule and not a malformed field. An integrator can catch it,
 * round the amount up and retry; they can do nothing programmatic with "one
 * of your fields was wrong".
 */
export function chargeFloorRefusal(what: string, amount: number | bigint): {
  status: 422;
  code: string;
  message: string;
  details: { amount: string };
} {
  const message = chargeFloorMessage(what, amount);
  return { status: 422, code: CHARGE_FLOOR_CODE, message, details: { amount: message } };
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
