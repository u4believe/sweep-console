/**
 * Does the permit ceiling cover the operation that failed?
 *
 * On 2026-10-28 a live Arbitrum payment died at validatePaymasterUserOp with
 * "ERC20: transfer amount exceeds allowance". The ceiling was floor*2 = 0.08
 * and the EntryPoint wanted more. This replays that operation's own gas
 * limits against the current ceiling so the fix is checked rather than
 * asserted — and so a later change to the floors cannot quietly reintroduce
 * it.
 */
/**
 * Mainnet IDs, so the PER-CHAIN defaults are what gets checked.
 *
 * Set before the import, because chainKeyForId reads the network at call time
 * from the table isMainnet() picks. Without it, 8453 and 42161 resolve to
 * nothing, every lookup lands on the fallback, and all three chains report
 * the same numbers — which is a check of the fallback wearing the costume of
 * a check of the defaults.
 */
process.env.ARC_NETWORK = "mainnet";
delete process.env.SETTLEMENT_GAS_FLOOR_USDC;
delete process.env.SETTLEMENT_PERMIT_CEILING_USDC;

import { settlementGasFloor, settlementPermitCeiling } from "../src/lib/chain/settlement-target.js";

const FAILED = {
  callGasLimit: 358_174n,
  verificationGasLimit: 1_500_000n, // the account deployed in this op
  preVerificationGas: 77_436n,
  paymasterVerificationGasLimit: 200_000n,
  paymasterPostOpGasLimit: 65_000n,
};
const TOTAL_GAS = Object.values(FAILED).reduce((a, b) => a + b, 0n);
const MAX_FEE_WEI = 27_908_496n; // 0.027908496 gwei, from the log

function usdcNeeded(ethPriceUsd: number): bigint {
  return BigInt(Math.round((Number(TOTAL_GAS * MAX_FEE_WEI) / 1e18) * ethPriceUsd * 1e6));
}

function main(): void {
  const failures: string[] = [];
  console.log("  chain      floor   ceiling");
  for (const [name, id] of [["base", 8453], ["arbitrum", 42161], ["optimism", 10]] as const) {
    console.log(`  ${name.padEnd(9)} ${String(settlementGasFloor(id)).padStart(6)} ${String(settlementPermitCeiling(id)).padStart(9)}`);
  }

  const ceiling = settlementPermitCeiling(42161);
  console.log(`\n  the Arbitrum operation that failed (${TOTAL_GAS} gas):`);
  // Up to $5000 — the ceiling should not be the thing that breaks first if ETH runs.
  for (const price of [2500, 3000, 3500, 4000, 5000]) {
    const need = usdcNeeded(price);
    const ok = need <= ceiling;
    if (!ok) failures.push(`ETH $${price}: needs ${need}, ceiling ${ceiling}`);
    console.log(`    ETH $${String(price).padEnd(5)} needs ${String(need).padStart(7)}  ${ok ? "covered" : "SHORT"}`);
  }

  // The ceiling must also clear the deployment case on every paymaster chain.
  // Base measured 0.055689 deploying on mainnet; Arbitrum has no mainnet
  // measurement, so its testnet steady state x8.5 stands in.
  const DEPLOY_COST: Record<number, bigint> = { 8453: 55_689n, 42161: 140_777n };
  for (const [id, cost] of Object.entries(DEPLOY_COST)) {
    const c = settlementPermitCeiling(Number(id));
    if (c < cost) failures.push(`chain ${id}: ceiling ${c} under measured deployment ${cost}`);
  }

  if (failures.length === 0) {
    console.log("\nPASS. The ceiling clears the operation that failed, and every measured deployment.");
  } else {
    console.log(`\nFAIL. ${failures.length} problem(s):`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main();
