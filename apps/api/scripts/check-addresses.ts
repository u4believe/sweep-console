import "dotenv/config";
import { getAddress, isAddress } from "viem";

/**
 * Every address we hand the wallet, checked for a valid EIP-55 checksum.
 *
 * The Smart Accounts Kit validates these strictly: a mixed-case address whose
 * checksum does not verify is rejected with "Invalid payees: must be a valid
 * address" BEFORE the request reaches MetaMask. Lowercase passes, correct
 * checksum passes, wrong mixed-case throws — which was reproduced against the
 * kit directly. An address that arrives mixed-case from a database row, a
 * copy-paste or an env var is therefore a grant that cannot be signed, and the
 * error names the field rather than the value.
 */
function check(label: string, raw: string | undefined): boolean {
  if (!raw) {
    console.log(`  ${label.padEnd(34)} (unset)`);
    return true;
  }
  if (!isAddress(raw)) {
    console.log(`  ${label.padEnd(34)} NOT AN ADDRESS: ${raw}`);
    return false;
  }
  const isLower = raw === raw.toLowerCase();
  const correct = getAddress(raw);
  const ok = isLower || raw === correct;
  console.log(
    `  ${label.padEnd(34)} ${ok ? "ok" : "BAD CHECKSUM"}  ${raw}${ok ? (isLower ? "  (lowercase)" : "") : `\n      should be: ${correct}`}`
  );
  return ok;
}

async function main() {
  let bad = 0;
  const env: Array<[string, string | undefined]> = [
    ["RENEWAL_DELEGATE_MSCA_ADDRESS", process.env.RENEWAL_DELEGATE_MSCA_ADDRESS],
    ["SETTLEMENT_MSCA_ADDRESS", process.env.SETTLEMENT_MSCA_ADDRESS],
    ["EXTERNAL_RELAYER_MSCA_ADDRESS", process.env.EXTERNAL_RELAYER_MSCA_ADDRESS],
    ["VITE_RENEWAL_DELEGATE_ADDRESS", process.env.VITE_RENEWAL_DELEGATE_ADDRESS],
    ["TREASURY_ADDRESS", process.env.TREASURY_ADDRESS],
    ["PLATFORM_TREASURY_ADDRESS", process.env.PLATFORM_TREASURY_ADDRESS],
    ["SETTLEMENT_ADDRESS", process.env.SETTLEMENT_ADDRESS],
  ];
  console.log("environment addresses");
  for (const [k, v] of env) if (!check(k, v)) bad += 1;

  console.log("\nUSDC per chain (chains.ts)");
  const { supportedSourceChains } = await import("../src/lib/gateway/chains");
  for (const c of supportedSourceChains()) if (!check(`${c.key} USDC`, c.usdc)) bad += 1;

  console.log(
    bad === 0
      ? "\nEvery address verifies. None would be refused for its checksum."
      : `\n${bad} address(es) would be REFUSED by the kit before MetaMask sees the request.`
  );
  if (bad > 0) process.exitCode = 1;
}
main();
