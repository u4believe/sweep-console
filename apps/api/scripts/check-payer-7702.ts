import "dotenv/config";
import { createPublicClient, http } from "viem";
import { base, arbitrum, optimism, monad } from "viem/chains";

/**
 * Is the PAYER a smart account on each chain?
 *
 * MetaMask grants an ERC-7715 permission only from a smart account, so
 * grantMandates calls ensureSmartAccount first: a two-call atomic batch via
 * wallet_sendCalls, which is what prompts MetaMask's upgrade offer. The
 * subscriber approving that prompt is NOT proof the upgrade happened — a
 * wallet can service an atomic batch without delegating the account, in which
 * case the batch succeeds, the account stays a plain EOA, and every
 * subsequent permission request is refused.
 *
 * EIP-7702 delegation is visible on chain: the account carries 23 bytes of
 * code beginning 0xef0100 followed by the implementation address.
 */
const PAYER = process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

async function main() {
  if (!PAYER) {
    console.log("usage: pnpm tsx scripts/check-payer-7702.ts 0x<payer address>");
    return;
  }
  for (const [key, chain] of [["base", base], ["arbitrum", arbitrum], ["optimism", optimism], ["monad", monad]] as const) {
    try {
      const pc = createPublicClient({ chain, transport: http() });
      const code = await pc.getCode({ address: PAYER as `0x${string}` });
      if (!code || code === "0x") {
        console.log(`  ${key.padEnd(9)} PLAIN EOA — not upgraded, so a 7715 permission is refused here`);
        continue;
      }
      const is7702 = code.toLowerCase().startsWith("0xef0100");
      const impl = is7702 ? `0x${code.slice(8, 48)}` : "";
      console.log(
        `  ${key.padEnd(9)} ${is7702 ? `7702 SMART ACCOUNT -> ${impl}` : `contract (${(code.length - 2) / 2} bytes), not a 7702 delegation`}`
      );
    } catch {
      console.log(`  ${key.padEnd(9)} RPC failed — not checked`);
    }
  }
}
main();
