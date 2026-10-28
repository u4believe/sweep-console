// Mint a CCTP burn that was left unredeemed on the destination chain.
//
//   ARC_NETWORK=mainnet pnpm tsx scripts/finish-cctp-mint.ts --burn 0x… --domain 3
//   ARC_NETWORK=mainnet pnpm tsx scripts/finish-cctp-mint.ts --burn 0x… --domain 3 --apply
//
// Dry by default. Nothing moves without --apply.
//
// WHY THIS EXISTS
//
// A burn and its mint are two transactions on two chains, and everything
// between them is someone remembering to finish. Twice now the burn has
// succeeded and the mint has not:
//
//   2026-10-23  the first recover-stranded-settlement stopped after the burn
//               and printed "the mint follows the attestation" — true of the
//               live path, false of a recovery. Minted by hand.
//
//   2026-10-28  recover-stranded-settlement burned 2.627672 USDC on Arbitrum
//               (0x2389a5c7…baa8f) and then threw on a DIAGNOSTIC balance read
//               pinned to the receipt's block, which the public Arbitrum RPC
//               refused with "unsupported block number". The burn was already
//               final. The throw cost the mint.
//
// Burned USDC is not lost and not at risk: the message names its mintRecipient,
// so whoever submits the attestation, the money can only land where the burn
// said. What it needs is a submitter. That is all this is.
//
// SAFE TO RE-RUN. receiveOnArc checks whether the nonce has already been used
// and returns the existing settlement rather than paying for a second mint, so
// running this against an already-minted burn costs nothing.

import "dotenv/config";
import { formatUnits, type Hex } from "viem";
import { fetchAttestation, receiveOnArc } from "../src/lib/gateway/cctp";
import { isMainnet } from "../src/lib/gateway/chains";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/// Circle's domain ids for the chains this platform burns from. Named rather
/// than passed as a bare number so a typo is a refusal, not a lookup of
/// somebody else's chain.
const DOMAINS: Record<string, number> = { ethereum: 0, avalanche: 1, optimism: 2, arbitrum: 3, base: 6 };

async function main(): Promise<void> {
  const burn = arg("burn") as Hex | undefined;
  const domainArg = arg("domain");
  const apply = process.argv.includes("--apply");

  if (!burn || !domainArg) {
    console.log("Usage: --burn 0x<burn tx hash> --domain <arbitrum|base|optimism|number> [--apply]");
    process.exitCode = 1;
    return;
  }
  const domain = DOMAINS[domainArg] ?? (/^\d+$/.test(domainArg) ? Number(domainArg) : undefined);
  if (domain === undefined) {
    console.log(`Unknown domain "${domainArg}". Known: ${Object.keys(DOMAINS).join(", ")}, or a number.`);
    process.exitCode = 1;
    return;
  }

  console.log(`network      ${isMainnet() ? "MAINNET" : "testnet"}`);
  console.log(`burn         ${burn}`);
  console.log(`source       domain ${domain}${Object.entries(DOMAINS).find(([, d]) => d === domain)?.[0] ? ` (${Object.entries(DOMAINS).find(([, d]) => d === domain)![0]})` : ""}\n`);

  // Short timeout: this is run against a burn that already happened, so the
  // attestation is either there or something is wrong. The twenty minutes the
  // live path waits is for a burn made seconds ago.
  const att = await fetchAttestation(domain, burn, { timeoutMs: 90_000, pollMs: 5_000 });

  /**
   * Read the recipient and amount out of the message rather than trusting the
   * caller's intent. The burn decided both; this prints what WILL happen, not
   * what someone meant to happen.
   *
   * Layout of the V2 burn message body, after the 148-byte header:
   *   [0:4] version  [4:36] burnToken  [36:68] mintRecipient  [68:100] amount
   */
  const body = att.message.slice(2 + 148 * 2);
  const mintRecipient = `0x${body.slice(36 * 2 + 24, 68 * 2)}`;
  const amount = BigInt(`0x${body.slice(68 * 2, 100 * 2)}`);
  console.log(`  mints        ${formatUnits(amount, 6)} USDC (less CCTP's fee)`);
  console.log(`  to           ${mintRecipient}`);
  console.log(`  attestation  complete, ${att.attestation.length} chars\n`);

  if (!apply) {
    console.log("Dry run. Nothing moved. Re-run with --apply to submit the mint.");
    return;
  }

  const tx = await receiveOnArc(att);
  if (tx === null) {
    console.log("  receiveOnArc returned null — no mint was recorded. Check the destination chain.");
    process.exitCode = 1;
    return;
  }
  console.log(`  MINTED  ${tx}`);
  console.log(`  ${mintRecipient} should now hold the USDC on the destination chain.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
