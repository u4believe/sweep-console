// Phase 1, step 4 of the mainnet roll-out: verify every address settlement
// will trust on mainnet is actually deployed there, BEFORE any money moves.
//
//   pnpm tsx scripts/check-mainnet-addresses.ts
//
// Read-only. It opens no wallet, signs nothing and sends nothing — it reads
// getCode at each address on each mainnet and reports what is there.
//
// WHY THIS EXISTS
//
// Testnet and mainnet paymasters are DIFFERENT addresses, and the roll-out
// plan named the wrong one until 2026-10-17: it listed Circle Paymaster v0.8
// for Base and Arbitrum, which reads as correct because v0.8 is the newer
// version and covers more chains. It would have reverted.
//
// A paymaster must sit at the same EntryPoint as the account it pays for, and
// the Circle MSCA is circle_6900_v1 — ERC-4337 v0.7. So settlement needs the
// v0.7 paymaster, and the v0.8 one is wrong however current it looks. That is
// a hard thing to see by reading a config and an easy thing to see here.

import { createPublicClient, http, getAddress, type Address } from "viem";
import { base, arbitrum, optimism } from "viem/chains";

/// Named so a wrong one is obvious in the output, not just a hex string.
const ADDRESSES = {
  "EntryPoint v0.7": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "EntryPoint v0.8": "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  "Circle Paymaster v0.7 (mainnet)": "0x6C973eBe80dCD8660841D4356bf15c32460271C9",
  "Circle Paymaster v0.8 (mainnet)": "0x0578cFB241215b77442a541325d6A4E6dFE700Ec",
  "Circle Paymaster v0.7 (TESTNET — must NOT be on mainnet)":
    "0x31BE08D380A21fc740883c0BC434FcFc88740b58",
} as const;

/// What settlement actually uses. Mirrors settlement-target.ts rather than
/// re-deriving it, so a drift between the two shows up as a failed check.
const SETTLEMENT_USES: Record<string, string | null> = {
  base: "Circle Paymaster v0.7 (mainnet)",
  arbitrum: "Circle Paymaster v0.7 (mainnet)",
  optimism: null, // pays its own gas in ETH
};

const CHAINS = [
  { key: "base", chain: base, rpc: "https://mainnet.base.org" },
  { key: "arbitrum", chain: arbitrum, rpc: "https://arb1.arbitrum.io/rpc" },
  { key: "optimism", chain: optimism, rpc: "https://mainnet.optimism.io" },
];

async function main(): Promise<void> {
  console.log("Mainnet address verification — read-only, nothing is sent.\n");

  let problems = 0;

  for (const { key, chain, rpc } of CHAINS) {
    // An override matters here: a public RPC that rate-limits mid-run would
    // report a deployed contract as absent, which is the one wrong answer
    // this script must never give.
    const url = process.env[`RPC_URL_${chain.id}`] ?? rpc;
    const client = createPublicClient({ chain, transport: http(url) });

    console.log(`${key} (${chain.id})  via ${url}`);

    for (const [name, addr] of Object.entries(ADDRESSES)) {
      let deployed: boolean | null = null;
      try {
        const code = await client.getCode({ address: getAddress(addr) as Address });
        deployed = !!code && code !== "0x";
      } catch (e) {
        // Distinguished from "not deployed" on purpose — an unreachable node
        // is a different fact, and treating it as absence is how a working
        // address gets removed from a config.
        console.log(`  ?  ${name.padEnd(56)} RPC error: ${(e as Error).message.slice(0, 48)}`);
        problems++;
        continue;
      }

      const expected = SETTLEMENT_USES[key] === name;
      const mustNotExist = name.includes("must NOT");

      let verdict: string;
      if (mustNotExist) {
        verdict = deployed ? "WRONG — testnet address is live here" : "ok (absent, as expected)";
        if (deployed) problems++;
      } else if (expected) {
        verdict = deployed ? "DEPLOYED — settlement uses this" : "MISSING — settlement would revert";
        if (!deployed) problems++;
      } else {
        verdict = deployed ? "deployed (unused)" : "absent";
      }

      console.log(`  ${deployed ? "+" : "-"}  ${name.padEnd(56)} ${verdict}`);
    }

    if (SETTLEMENT_USES[key] === null) {
      console.log(`  =  ${"gas".padEnd(56)} native ETH — no paymaster on this chain`);
    }
    console.log();
  }

  console.log(
    problems === 0
      ? "PASS. Every address settlement trusts on mainnet is deployed, and no testnet address is."
      : `FAIL. ${problems} problem(s) above — do not fund or cut over until each is understood.`
  );
  if (problems > 0) process.exitCode = 1;
}

void main();
