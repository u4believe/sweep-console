// Phase 2 dry run: prove the grant path and the settlement path agree on
// mainnet BEFORE a single grant exists.
//
//   ARC_NETWORK=mainnet pnpm tsx scripts/preflight-mainnet.ts
//
// Read-only and offline except for one getCode per chain. It signs nothing,
// sends nothing and touches no database.
//
// WHY A SECOND CHECKER
//
// check-settlement-targets.ts answers the same question over the grants that
// EXIST. On mainnet none do, so it has nothing to say until the first payer
// has already granted — which is exactly too late.
//
// THE BUG CLASS, AND WHICH HALF OF IT EACH CHECK COVERS
//
// settlementPayeeFor() decides what a NEW grant pins. settlementTargetFor()
// decides where an EXISTING grant settles. A disagreement pulls the payer's
// money and then reverts, because AllowedCalldataEnforcer rejects a
// redemption going anywhere but the pinned address.
//
// That disagreement has two halves, and they need different checks.
//
// The CONFIG half — the two functions resolving differently for the same
// chain — is what the per-chain section below covers, by running one into the
// other. Note what it cannot do: settlementTargetFor has exactly two
// outcomes, the EOA when the grant pins the EOA and the MSCA otherwise, so a
// synthetic third address cannot make them disagree. The check is still worth
// running for settlementPayeeFor's throw on mixed coverage and for the
// viaMsca agreement, but it is not the one that would have caught the bug we
// actually shipped.
//
// The CALL-SITE half is. The real defect was that settlementPayeeFor existed,
// was correct, and was never called: all four grant sites pinned the EOA
// directly while chainSettlesViaMsca chose the MSCA. No amount of running the
// functions against each other sees that, because the broken code does not
// call them. Only reading the sites does, which is the static section.

import "dotenv/config";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createPublicClient, encodeAbiParameters, http, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, arbitrum, optimism } from "viem/chains";
import {
  chainPaysOwnGas,
  chainSettlesViaMsca,
  chainUsesPaymaster,
  circlePaymasterV07,
  settlementPayeeFor,
  settlementTargetFor,
} from "../src/lib/chain/settlement-target";
import { isMainnet } from "../src/lib/gateway/chains";

/// Mirrors settlement-target.ts. A grant's payee lives inside a caveat's
/// terms, which is why grantPins() searches there rather than at a fixed
/// offset — the enforcers pack terms differently.
const DELEGATION_ABI_PARAMS = [
  {
    type: "tuple[]",
    components: [
      { name: "delegate", type: "address" },
      { name: "delegator", type: "address" },
      { name: "authority", type: "bytes32" },
      {
        name: "caveats",
        type: "tuple[]",
        components: [
          { name: "enforcer", type: "address" },
          { name: "terms", type: "bytes" },
          { name: "args", type: "bytes" },
        ],
      },
      { name: "salt", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

/**
 * The context a real grant would carry, for a given payee.
 *
 * Only the caveat terms matter to the routing, so the rest is filled with
 * zeroes rather than faked — a plausible-looking fake would invite someone to
 * read meaning into fields this check does not exercise.
 */
function contextPinning(payee: Address): Hex {
  return encodeAbiParameters(DELEGATION_ABI_PARAMS, [
    [
      {
        delegate: zeroAddress,
        delegator: zeroAddress,
        authority: `0x${"00".repeat(32)}` as Hex,
        caveats: [{ enforcer: zeroAddress, terms: payee as Hex, args: "0x" as Hex }],
        salt: 0n,
        signature: "0x" as Hex,
      },
    ],
  ]);
}

const CHAINS = [
  { key: "base", chain: base, rpc: "https://mainnet.base.org" },
  { key: "arbitrum", chain: arbitrum, rpc: "https://arb1.arbitrum.io/rpc" },
  { key: "optimism", chain: optimism, rpc: "https://mainnet.optimism.io" },
];

async function main(): Promise<void> {
  if (!isMainnet()) {
    console.log("ARC_NETWORK is not 'mainnet'. Re-run as:\n");
    console.log("  ARC_NETWORK=mainnet pnpm tsx scripts/preflight-mainnet.ts\n");
    console.log("Running it against testnet config would check the wrong table and pass.");
    process.exitCode = 1;
    return;
  }

  let problems = 0;
  const note = (bad: boolean, line: string) => {
    if (bad) problems++;
    console.log(`  ${bad ? "FAIL" : "ok  "}  ${line}`);
  };

  console.log(`SETTLEMENT_MSCA_ADDRESS   ${process.env.SETTLEMENT_MSCA_ADDRESS ?? "(unset)"}`);
  console.log(`SETTLEMENT_MSCA_ENABLED   ${process.env.SETTLEMENT_MSCA_ENABLED ?? "(unset)"}`);
  console.log(`KMS_PROVIDER              ${process.env.KMS_PROVIDER ?? "(unset)"}\n`);

  for (const { key, chain, rpc } of CHAINS) {
    console.log(`${key} (${chain.id})`);

    // 1. What a new grant pins, and where that grant would settle. The whole
    //    point: run one into the other.
    let payee: Address;
    try {
      payee = settlementPayeeFor(chain.id);
    } catch (e) {
      note(true, `settlementPayeeFor threw: ${(e as Error).message.slice(0, 70)}`);
      console.log();
      continue;
    }

    const target = settlementTargetFor(chain.id, contextPinning(payee));
    note(
      target.address.toLowerCase() !== payee.toLowerCase(),
      `grant pins ${payee} -> settles into ${target.address}`
    );

    // 2. The gas policy has to be coherent with that choice. An MSCA on a
    //    paymaster chain needs the paymaster deployed; one paying its own gas
    //    needs ETH, which is a funding fact rather than a code fact and is
    //    only reported here.
    const viaMsca = chainSettlesViaMsca(chain.id);
    note(
      viaMsca !== target.viaMsca,
      `chainSettlesViaMsca=${viaMsca} agrees with the resolved target (viaMsca=${target.viaMsca})`
    );

    if (chainUsesPaymaster(chain.id)) {
      const pm = circlePaymasterV07(chain.id);
      if (!pm) {
        note(true, "chainUsesPaymaster is true but circlePaymasterV07 returned null");
      } else {
        const client = createPublicClient({ chain, transport: http(process.env[`RPC_URL_${chain.id}`] ?? rpc) });
        const code = await client.getCode({ address: pm }).catch(() => null);
        note(!code || code === "0x", `Circle Paymaster v0.7 at ${pm} is deployed`);
      }
    } else if (chainPaysOwnGas(chain.id)) {
      console.log(`  --    pays its own gas: fund ${payee} with ETH on ${key}`);
    }

    console.log();
  }

  /**
   * Four roles, four keys, and nothing in the code says so.
   *
   * Two silent failures live here. getSettlementAccount() falls back to the
   * hosted relayer when SETTLEMENT_PRIVATE_KEY is unset (signers.ts:121),
   * so an unset variable does not error — settlement just quietly becomes the
   * platform key. And nothing stops two variables holding the SAME key, which
   * collapses the separation while every address still looks populated.
   *
   * Both matter more on mainnet than testnet: the settlement account is the
   * payee in every grant, and the delegates are named as the delegate. If one
   * key covers two roles, a single leak costs both.
   *
   * Addresses only below. The keys themselves are never read into output.
   */
  console.log("keys");
  const ROLES: Array<[string, string]> = [
    ["SETTLEMENT_PRIVATE_KEY", "owns the settlement MSCA, payee in every grant"],
    ["RENEWAL_DELEGATE_PRIVATE_KEY", "owns the renewal delegate MSCA"],
    ["EXTERNAL_RELAYER_PRIVATE_KEY", "owns the external relayer MSCA"],
    ["PLATFORM_PRIVATE_KEY", "hosted relayer"],
  ];

  const seen = new Map<string, string>();
  for (const [envVar, what] of ROLES) {
    const raw = process.env[envVar];
    if (!raw) {
      // Only SETTLEMENT_PRIVATE_KEY has the dangerous fallback; the others
      // throw where they are used, which is loud enough.
      note(
        envVar === "SETTLEMENT_PRIVATE_KEY",
        `${envVar} is unset` +
          (envVar === "SETTLEMENT_PRIVATE_KEY"
            ? " — settlement would SILENTLY use PLATFORM_PRIVATE_KEY (signers.ts:121)"
            : "")
      );
      continue;
    }

    let address: string;
    try {
      // Normalised exactly as signers.ts accountFor() does: the 0x prefix is
      // optional there, and SETTLEMENT_PRIVATE_KEY is in fact stored without
      // it. A stricter check here would report a working key as broken, and
      // the first false positive is what teaches everyone to ignore the tool.
      const trimmed = raw.trim();
      const hex = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
      address = privateKeyToAccount(hex).address;
    } catch {
      note(true, `${envVar} is set but is not a valid 32-byte private key`);
      continue;
    }

    const clash = seen.get(address.toLowerCase());
    note(!!clash, `${envVar.padEnd(28)} ${address}  ${clash ? `SAME KEY AS ${clash}` : what}`);
    seen.set(address.toLowerCase(), envVar);
  }
  console.log();

  // The call-site half. A grant site that builds a payee without going
  // through settlementPayeeAddress() is the defect that shipped once already,
  // and it is invisible to every runtime check above.
  console.log("grant sites");
  const ROUTES = join(__dirname, "..", "src", "routes");
  let sites = 0;
  for (const name of readdirSync(ROUTES).filter((f) => f.endsWith(".ts"))) {
    const lines = readFileSync(join(ROUTES, name), "utf8").split("\n");
    lines.forEach((line, i) => {
      // The payee expression, not the comment that mentions the helper.
      if (!/\bconst\s+payee\s*=/.test(line)) return;
      sites++;
      note(
        !line.includes("settlementPayeeAddress()"),
        `${name}:${i + 1} builds a payee via settlementPayeeAddress()`
      );
    });
  }
  note(sites === 0, `found ${sites} grant site(s) to check`);
  console.log();

  console.log(
    problems === 0
      ? "PASS. On every mainnet chain, the grant's payee and settlement's target are the same\n" +
          "      address, and every grant site derives its payee from settlementPayeeAddress()."
      : `FAIL. ${problems} problem(s). A grant that pins one address while settlement targets another\n` +
          "       pulls the payer's money and then reverts. Do not cut over."
  );
  if (problems > 0) process.exitCode = 1;
}

void main();
