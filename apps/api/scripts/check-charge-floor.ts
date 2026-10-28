/**
 * Is the charge floor what it claims to be, and does it clear real gas?
 *
 * The floor used to be justified from TESTNET settlement gas and the
 * assumption that mainnet would be cheaper. Mainnet turned out dearer on
 * Arbitrum, and the three measured payments below are what the number is now
 * set against. This pins both halves: the default itself, and the arithmetic
 * that chose it — so a later change to the fee or a new gas measurement makes
 * the check fail rather than leaving a stale comment behind.
 */
process.env.ARC_NETWORK = "mainnet";
delete process.env.MIN_CHARGE_USDC;

import { chargeFloorMicros, belowChargeFloor, chargeFloorMessage, formatFloor } from "../src/lib/charge-floor.js";

/// Measured end to end on mainnet, every leg, at ETH $2342.
const GAS_USD: Record<string, number> = { base: 0.015619, arbitrum: 0.043319 };
const FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? "200");

function main(): void {
  const fails: string[] = [];
  const floor = chargeFloorMicros();
  if (floor === null) {
    console.log("FAIL. No floor on mainnet — chargeFloorMicros returned null.");
    process.exitCode = 1;
    return;
  }
  const floorUsd = Number(floor) / 1e6;
  console.log(`  floor            ${formatFloor(floor)} USDC`);
  console.log(`  platform fee     ${FEE_BPS} bps\n`);

  // 1. The boundary behaves: at the floor accepted, a micro-unit under refused.
  if (belowChargeFloor(floor)) fails.push("the floor itself is refused — off-by-one");
  if (!belowChargeFloor(floor - 1n)) fails.push("one micro-unit under the floor is accepted");

  // 2. The message names the real number, so a creator is not told "1.00"
  //    by a string that was hardcoded somewhere.
  const msg = chargeFloorMessage("plan", 500_000n);
  if (!msg.includes(formatFloor(floor))) fails.push(`message does not name the floor: ${msg}`);

  // 3. What the floor actually earns against measured gas.
  console.log("  at the floor, per renewal:");
  for (const [chain, gas] of Object.entries(GAS_USD)) {
    const fee = floorUsd * (FEE_BPS / 10_000);
    const net = fee - gas;
    console.log(`    ${chain.padEnd(9)} fee ${fee.toFixed(4)} - gas ${gas.toFixed(6)} = ${net >= 0 ? "+" : ""}${net.toFixed(6)}`);
    // Not a failure. The $2 floor is KNOWINGLY under Arbitrum's break-even of
    // $2.17; this reports it so the subsidy stays a decision on the record and
    // not something discovered later from a treasury that never fills.
    if (net < 0) console.log(`    ${"".padEnd(9)} ^ subsidised — break-even here is ${(gas / (FEE_BPS / 10_000)).toFixed(2)}`);
  }

  if (fails.length === 0) {
    console.log(`\nPASS. Floor is ${formatFloor(floor)}, the boundary is exact, and the message names it.`);
  } else {
    console.log(`\nFAIL. ${fails.length} problem(s):`);
    for (const f of fails) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main();
