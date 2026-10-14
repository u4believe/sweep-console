// Exercise the real settleViaUserOp() against testnet, not a probe copy of it.
//
//   SETTLEMENT_USEROP_ENABLED=true BUNDLER_URL_84532=https://public.pimlico.io/v2/84532/rpc \
//     pnpm tsx scripts/try-settle-userop.ts
//
// Burns a token amount to Arc with the treasury as the mint recipient, so a
// successful run moves real testnet USDC. Amounts are deliberately tiny.
import "dotenv/config";
import { formatUnits, parseUnits, type Address } from "viem";
import { getSourceChain } from "../src/lib/gateway/chains";
import { getTokenMessenger } from "../src/lib/gateway/cctp";
import { treasuryAddress } from "../src/lib/chain/fee-payout";
import { getSettlementAddress } from "../src/lib/chain/signers";
import { chainSettlesViaMsca } from "../src/lib/chain/settlement-target";
import { settleViaUserOp } from "../src/lib/chain/settlement-userop";

async function main() {
  const source = getSourceChain(process.argv.includes("--chain") ? process.argv[process.argv.indexOf("--chain")+1]! : "base");
  const treasury = treasuryAddress();
  if (!treasury) throw new Error("PLATFORM_TREASURY_ADDRESS is not set");

  console.log("settlement address :", getSettlementAddress());
  console.log("chain settles via MSCA?", chainSettlesViaMsca(source.chain.id));
  if (!chainSettlesViaMsca(source.chain.id)) {
    console.log("  -> flag off or chain unsupported; nothing to exercise.");
    return;
  }

  const merchantShare = parseUnits("0.05", 6);
  const gross = parseUnits("0.10", 6);
  const r = await settleViaUserOp({
    chainId: source.chain.id,
    token: source.usdc,
    tokenMessenger: getTokenMessenger(source.key),
    amount: merchantShare,
    destinationDomain: 26,
    mintRecipient: treasury as Address,
    speed: "fast",
    grossAmount: gross,
    treasury: treasury as Address,
  });
  console.log("\nburnTxHash :", r.burnTxHash);
  console.log("maxFee     :", formatUnits(r.maxFee, 6), "USDC");
  console.log("feePaid    :", formatUnits(r.feePaid, 6), "USDC -> treasury");
  console.log("toppedUp   :", formatUnits(r.toppedUp, 6), "USDC kept for gas");
  console.log("gasPaid    :", formatUnits(r.gasPaid, 6), "USDC");
}
main().catch((e) => {
  console.error("message     :", e?.shortMessage ?? e?.message);
  console.error("details    :", e?.details);
  let c = e?.cause, d = 0;
  while (c && d++ < 4) { console.error(`cause[${d}]   :`, c.shortMessage ?? String(c.message ?? "").split("\n")[0]); c = c.cause; }
  process.exitCode = 1;
});
